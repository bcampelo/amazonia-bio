# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

BioAmazon IA is a hackathon MVP for an **offline-first, edge-AI** digital journey for
extractivist products (açaí, to start). A producer speaks (+ optionally photographs the
product), **Gemma** extracts a structured spec sheet ("ficha técnica"), an operator confirms
(and can correct) the facts, Gemma generates a marketing narrative from only the confirmed
facts, and the result is published as a public page with a QR code.

The architectural bet for the **final target** (Android/LiteRT-LM, browser/WebGPU) is that
inference runs on the device, no server required for intelligence. For **development on a
laptop** (no GPU, no downloaded weights), the same `gemma_generate` contract talks to real
Gemma hosted via the **Gemini API** instead — this is a deliberate, explicit exception to
the offline-first story, scoped to the dev/demo path only (see "The gemini backend" below).

## Commands

Install deps and configure the Gemini API key (free, no credit card, from
aistudio.google.com/app/apikey):
```bash
pip3 install -r requirements.txt
cp .env.example .env   # then paste your GEMINI_API_KEY into .env
```

Run the whole app (frontend + backend, one process):
```bash
python3 server/app.py   # http://localhost:8000
```

Run just the pipeline PoC via CLI (no browser):
```bash
GEMMA_BACKEND=mock python3 cli/run_poc.py --text-file seed/transcript_acai.txt      # no network/key needed
GEMMA_BACKEND=gemini python3 cli/run_poc.py --text-file seed/transcript_acai.txt    # real Gemma
GEMMA_BACKEND=ollama python3 cli/run_poc.py --text-file seed/transcript_acai.txt    # local Ollama, needs it installed+running
```
`run_poc.py` also accepts `--text "..."` instead of `--text-file`, `--image <path>`,
`--cooperativa "..."`, and `--out <path>` to dump the resulting record as JSON.

Lint (installed via requirements, not stdlib): `ruff check backend cli server`. There is no
JS linter configured; `node --check <file>` catches syntax errors. No test suite exists yet.

## Architecture

### The golden rule: one function is the entire AI boundary

`backend/gemma/gemma_generate.py` (`gemma_generate(prompt, images=, audio=, backend=,
temperature=, max_tokens=, json_mode=)`) is the **only** place that talks to a model.
Swapping `mock -> gemini -> ollama -> LiteRT (Android) -> WebGPU (browser)` must be a
config/backend change, never a rewrite of calling code. `frontend/gemma-web.js` is the
browser mirror of this same contract (same prompts, same schema) for the WebGPU/mock paths;
when you change a prompt or the ficha schema on one side, mirror it on the other. The
Android path (`android/README_LITERT.md`) is expected to implement the identical
`gemma_generate(prompt, image, audio) -> text` signature in Kotlin over LiteRT-LM, reusing
the Python prompts/schema unchanged.

Do not introduce Whisper, Llama, or any other model as the reasoning "brain" — extraction
and narrative generation must always go through Gemma. The one narrow exception is speech
transcription (ASR), which is not reasoning, just turning sound into text. ASR is now
**offline-first**, in its own `backend/asr/` package (NOT a `gemma_generate` backend, so
nobody confuses ASR with the Gemma brain). `transcribe.py::transcribe()` returns
`{transcript, engine, ms}` and picks, in order: (1) **whisper.cpp LOCAL** (`whisper-cli` +
`backend/asr/models/ggml-small.bin`, runs offline on Metal/CPU — this is what removed the last
internet dependency; ~1 s for a ~10 s pt-BR clip); (2) **Gemini cloud fallback**
(`GEMINI_ASR_MODEL`, `gemini-flash-latest`) only if whisper.cpp isn't installed. In the
browser, `app.js::onRecordingStopped()` now treats the **local server whisper as authoritative**
(Web Speech is only an online live-preview), so the recorded audio → WAV (`toWavMono`) →
`/api/transcrever` → whisper is the offline path. The three routes (`/api/transcrever`,
`/api/extrair`, `/api/narrar`) each return `ms`, and the UI shows a per-step + total timing
line (`#tempos`). **On Android/LiteRT-LM there is no separate ASR at all** — Gemma 3n
transcribes natively (Audio Scribe); whisper.cpp is the laptop/PWA equivalent. Setup:
`brew install whisper-cpp` + download a ggml model (see `.env.example` `WHISPER_*`).
Measured full offline pipeline (audio→ASR→relato→ficha→narrative): ~18–23 s total, all local.

### The `gemini` backend — real Gemma, no local weights

`_gemini()` in `gemma_generate.py` uses the official `google-genai` SDK to call
Gemma models hosted on the Gemini API (`gemma-4-26b-a4b-it` by default, `gemma-4-31b-it` as
a larger alternative — set via `GEMINI_MODEL`). Two non-obvious constraints discovered by
testing, not assumed:
- **These models "think" before answering and `thinking_budget` cannot be disabled for
  them** (the API rejects it). Without a generous token budget the whole response gets
  consumed by the hidden thinking trace and the final answer comes back empty. `_gemini()`
  enforces a floor of `max(max_tokens, 2048)` internally so callers never need to know
  about this quirk — don't lower this floor without re-testing for empty responses.
  **Concretely observed:** `narrate()` at `max_tokens=400` (floor 2048) returned an EMPTY
  narrative because the thinking trace alone spilled past ~1350 tokens and varied per call.
  Two fixes now in place: extraction passes a **`response_schema`** (structured output — the
  model can't ramble, so the ficha never truncates and stopped coming back with empty
  fields), and `narrate()`/`estruturar_relato()` pass a **generous `max_tokens` (8192/4096)**.
  A higher cap does NOT slow generation (the model emits STOP when done) — it only leaves
  room for the answer after the hidden thinking. Never drop these budgets without re-testing.
- **Audio input is rejected** (`"Audio input modality is not enabled for this model"`) for
  both Gemma models above — text and image only. This is why speech is transcribed by ASR
  (browser Web Speech API, or the `backend/asr/` server fallback — see the ASR note above)
  and only the resulting TEXT reaches Gemma; Gemma still does 100% of the actual extraction/
  narrative reasoning. True audio-native Gemma is expected only on the Android/LiteRT-LM
  path, which already documented this same limitation for Ollama-on-laptop before the
  `gemini` backend existed.
- `.env` (git-ignored) is loaded by a small hand-rolled parser in `gemma_generate.py`
  (`_load_dotenv`) — no `python-dotenv` dependency. `.env.example` documents the vars.

### Two-pass pipeline (`backend/pipeline.py`)

1. **`extract()`** — Passage 1. Builds a multimodal prompt (`backend/extraction/prompt.py`)
   from transcript + optional image, calls `gemma_generate` with `json_mode=True`, low
   temperature, parses the JSON response (recovering from dirty/truncated output by slicing
   the first `{...}` block), then runs it through `_sanitize()`.
2. **`_sanitize()`** — real models don't always respect the schema perfectly (e.g. Gemma has
   been observed emitting `"provenance": "não informado"`, which isn't a valid provenance
   tag). This rebuilds the ficha field-by-field from `empty_ficha()`, coercing any
   provenance outside `PROVENANCES` to `"inferido"`. Do not reintroduce the old
   all-or-nothing "if invalid, replace the whole ficha with `empty_ficha()` merged back
   into itself" pattern — that merge was a no-op bug (it restored every field unchanged
   because they're all dicts), which is exactly how this surfaced.
3. **`confirm()`** — the human-in-the-loop trust step. Applies operator overrides and
   stamps every field's provenance as `"confirmado"`.
4. **`narrate()`** — Passage 2. Builds a narrative prompt (`backend/narrative/prompt.py`)
   using **only** fields from the confirmed ficha, never the raw extraction.

`run()` chains extract → confirm → narrate. `cli/run_poc.py` and `server/app.py` are both
thin callers of these same functions — treat them as reference call sites.

### The ficha schema and provenance

`backend/extraction/schema.py` defines `FICHA_FIELDS` (produto, variedade, origem,
metodo_coleta_manejo, epoca_safra, caracteristicas_sensoriais, praticas_sustentaveis,
volume, unidade). Every field is `{"value": ..., "provenance": ...}` where provenance is one
of `audio | imagem | inferido | confirmado` (`PROVENANCES` in the same file). This tag is
the traceability mechanism the whole product is built around. `FICHA_FIELDS` is duplicated
in `frontend/gemma-web.js` — keep both lists in sync if you add/remove a field.

### Anti-hallucination is a hard requirement, not a nicety

Both prompt builders (`backend/extraction/prompt.py`, `backend/narrative/prompt.py`, and
their JS mirror in `gemma-web.js`) explicitly forbid inventing origin, community,
certification, or seals — unstated facts must be `"não informado"`, never guessed. Verified
empirically against the real `gemini` backend (an unrelated test image produced
`"não informado"` for every fact not visible/spoken, not a fabricated guess). The narrative
prompt is further restricted to only reference facts present in the *confirmed* ficha. When
touching these prompts, preserve these constraints.

### `server/app.py` — the HTTP layer (Flask)

Single process, two jobs:
1. Serves `frontend/` as static files (`static_folder=FRONTEND_DIR, static_url_path=""`),
   same origin as the API — deliberately avoids CORS.
2. Mediates Gemma for the browser (`POST /api/extrair`, `POST /api/narrar`) and handles
   publishing (`POST /api/publicar`, `GET /p/<slug>`). `/api/publicar` slugifies the
   `produto` value + a short uuid, persists the confirmed record via `backend/db.py`
   (SQLite — chosen explicitly over Postgres/Supabase/Firebase specifically because it
   needs zero external credentials/services, see `bioamazon.db`, git-ignored, created at
   first run), generates a QR PNG (base64, via the `qrcode`+`pillow` libs) pointing at
   `request.host_url + /p/<slug>`, and returns `{slug, url, qr_base64}`. The public page is
   rendered with `render_template_string` (auto-escaped) reading that same row.

Run with `python3 server/app.py` (`sys.path` is patched at the top so `backend.*` imports
resolve regardless of cwd, same pattern as `cli/run_poc.py`). Port defaults to 8000
(configurable via `PORT`) — port 5000 is reserved by macOS AirPlay Receiver, don't default to it.

### `backend/db.py` — SQLite persistence

One table (`lotes`): `slug` (unique), `produto`, `cooperativa`, `ficha_json` (the full
9-field ficha as a JSON blob — not normalized column-per-field, deliberately, since nothing
yet needs to query individual fields), `narrativa`, `status`, `criado_em`. `listar_lotes()`
already exists (optionally filtered by `cooperativa`) for future consulta/histórico/dashboard
screens even though nothing calls it yet — wire it to a `GET /api/lotes` route when building
those screens rather than duplicating the query logic.

### Frontend (`frontend/`) — offline-first PWA

Vanilla JS, no build step. Load order from `index.html`: `config.js` (WebGPU/model config)
→ `evidence.js` (camera + GPS primitives) → `gemma-web.js` (backend selection + inference
calls) → `app.js` (the "Registrar" flow: capture, IndexedDB, sync) → `screens.js` (SPA router
+ the consultation screens). `sw.js` caches the app shell for offline use. **Classic scripts
share the global lexical scope**, so `screens.js` reuses `cooperativaNome`/state from `app.js`
and `app.js`'s `cooperativaNome()` calls `window.getCooperativa` (defined in `screens.js`) —
keep this ordering and don't wrap either file in a module/IIFE that would break the sharing
(`evidence.js`/`screens.js` are IIFEs but expose exactly what's needed on `window`).

`gemma-web.js`'s `init()` is **LOCAL-FIRST** (Edge AI is the architectural goal, remote is the
fallback — see the Edge AI section below): it tries **`webgpu`** (Gemma on-device) FIRST, then
**`server`** (real Gemma via `server/app.py`, remote), then **`"indisponivel"`**. On-device is
attempted only when (a) the browser has WebGPU and (b) a model is actually installed (asked via
`GET /api/modelo_local`, cached in localStorage so it also works offline) — otherwise it cleanly
falls through to the cloud. The Config screen's "Modo de IA" (`localStorage bioamazon.ia_mode`:
`auto`|`local`|`nuvem`) can force local-only or cloud-only. The active engine is surfaced in the
header pill (`📴 no dispositivo` green / `☁️ nuvem — fallback` / `indisponível`) and via
`GemmaWeb.local`/`GemmaWeb.engineLabel`. **There is no mock fallback anymore —
it was deleted on purpose.** It used to exist as a last-resort so the UI never hard-failed,
but its `mockFicha()` hardcoded `produto: "Açaí"` unconditionally regardless of what image
was sent, which silently produced fake-but-plausible results indistinguishable from real
extraction. If `server` and `webgpu` both fail, `extract()`/`narrate()` now throw explicitly
and the UI must surface that error, not paper over it. Do not re-add a client-side mock to
this file for any reason — if a demo needs a guaranteed-working path, run `server/app.py`
with the `gemini` backend, don't fake the response.

**Service worker caching pitfall (hit once, worth remembering):** `sw.js` originally cached
the app shell with a cache-first strategy and a cache name that never changed
(`bioamazon-v1`). Because browsers only re-run a service worker's `install` when the SW
script's bytes change, and `sw.js` itself wasn't being edited, updates to `app.js`/
`gemma-web.js` could sit on disk indefinitely while already-registered browsers kept serving
the stale cached versions — which is how the old hardcoded-"Açaí" mock kept showing up after
it had already been fixed in the source. `sw.js` is now network-first (falls back to cache
only when the network request fails) and bumped to `bioamazon-v2`. If shell files change
again, bump the `CACHE` constant, and remember a hard refresh (or clearing site data) may
still be needed on an already-open tab.

Flow in `app.js`: record button starts both `MediaRecorder` (audio, for playback/audit) and,
if available, the browser's native `SpeechRecognition` (`pt-BR`) to build a live text
transcript — this is *not* a second AI, just OS/browser ASR, because the `gemini` backend
can't accept audio (see above). Processing renders each ficha field as an **editable
`<input>`** (not read-only text) so the operator can actually correct values before
confirming — confirming reads the current input values back into `fichaAtual` and stamps
`provenance: "confirmado"`. Saving still goes to IndexedDB. Sync now really POSTs each
pending lote to `/api/publicar` and displays the returned QR image + public link in the UI
(`#publicadoCard`) — it no longer fabricates a slug client-side.

### Evidence chain (`frontend/evidence.js`) — the traceability spine (Phase 2)

Every photo is captured as an **auditable evidence item** stamped with GPS + timestamp +
source at the moment of capture. `evidence.js` (`window.Evidence`) owns two primitives:
`captureGPS()` (resolves `{ok,lat,lng,accuracy}` or `{ok:false,motivo}` — never rejects; needs
a secure context) and `capturePhoto(label)` (a `getUserMedia` + `<canvas>` live-camera modal).

**Deliberate decision — do NOT force "camera only" via `<input capture>`:** that attribute is
a no-op on desktop (where the demo runs on Mac Chrome — it just opens the file picker), so it
gives a false sense of security. Instead the in-app live camera is the default (works on
desktop AND mobile, lets us stamp GPS/time at the shutter), and a labeled **file-upload
fallback stays** inside the camera modal — but the evidence records its `fonte` as
`"camera"` (ao vivo / verificada) vs `"arquivo"` (não verificada). Trust level becomes a
recorded, auditable field rather than a blocked action. Do not "remove the gallery" by
hard-blocking uploads — it would break the desktop demo and weaken, not strengthen, trust.

`app.js` holds the chain model `CADEIA` (produtor · coleta · produto · audio · gemma ·
confirmacao · narrativa) and `evidencias{}`; each step calls `marcarEvidencia()` which
re-renders the visible timeline (`#cadeia`). The **produto** photo is the one fed to Gemma.
The whole `evidencias` object is persisted (`evidencias_json` column in `db.py`, sent via
`/api/publicar`) and rendered on the public page as a "Cadeia de evidências" card.

**Privacy (architect call):** the operator/app view and the DB keep full GPS precision for
audit, but the **public page rounds coordinates to ~2 decimals (~1 km)** via
`server/app.py::_gps_publico` — a public QR must not pin an extractivist's home/roçado. When
touching the public page, keep dynamic strings escaped (`_gps_publico` uses `markupsafe`) and
the coordinate-rounding intact.

### Structured relato + producer registry (Phase 3)

**Structured relato (intelligence over the producer's speech).** `estruturar_relato()`
(`backend/pipeline.py`) is no longer a light cleanup — its prompt (`build_relato_prompt`,
`backend/extraction/prompt.py`) turns raw ASR into a **professional, third-person
description** of the collection ("A coleta foi realizada no período da manhã, em uma área
próxima a um igarapé. O produtor informou que…"). Hard rule, enforced by a few-shot example
in the prompt: **invents nothing, removes no relevant fact, only reorganizes/formalizes.**
It's the Gemma doing it (not heuristics). The result feeds extraction AND is persisted
(`lotes.relato`) and shown on the public page as "Descrição da coleta". Keep the few-shot
example and the "não inventar / não remover" rules if you touch this prompt.

**Producer registry (`produtores` table in `db.py`).** Each lote can reference a producer
(`lotes.produtor_id`, nullable/back-compat). A producer has `codigo` (human id `PROD-XXXX`),
nome, comunidade, cooperativa, foto, lat/lng (localização principal), and an extensible
`indicadores_json`. Endpoints: `GET/POST /api/produtores`, `GET /api/produtores/<id>` (detail
includes `historico` = the producer's lotes + computed `indicadores`). In the UI (`app.js`),
the producer is selected/created at the top of the capture flow; **creating one reuses the
`produtor` evidence photo + GPS** so identity and location come from a live-captured evidence,
not typed by hand.

**Sustainability indicators are SCAFFOLDING, not a scoring system.** `calcular_indicadores()`
returns objective aggregates computed from history (total_lotes, lotes_rastreaveis_completos,
primeiro/ultimo_registro) plus **empty extensible fields** (regularidade_entregas,
boas_praticas, projetos_sustentaveis, selos) that future rules can fill *without schema
changes* — they're read from `indicadores_json`. Do NOT add scoring rules yet; the ask was
to prepare the structure, and the whole point is that the architecture already supports it.

### Edge AI / offline-first architecture (Phase 5)

The strategic goal: run on-device, sync only when online. Concretely:

**Local-first inference.** `gemma-web.js::init()` prefers on-device (WebGPU) over the remote
server (see the load-order note above). The MediaPipe/LiteRT **runtime is vendored** at
`frontend/vendor/tasks-genai/` (ESM + wasm, ~52 MB) so the on-device path needs **no CDN and no
internet** — `config.js` points `TASKS_GENAI_ESM`/`WASM_BASE` at the local vendor (CDN URLs kept
only as a `_CDN` fallback). The vendor dir + model files are git-ignored (large). What's NOT
committed is the **model weights**: the Web Gemma model is large (Gemma 3n E2B ~2.6 GB) and
license-gated, so it's dropped into `frontend/models/` via `scripts/baixar_modelo.sh` (documented
in `frontend/models/README.txt`). The moment a model file is present, `/api/modelo_local` reports
it and the app switches to on-device automatically — **the on-device path is fully wired; only the
weights are supplied out-of-band.** (This session did not download the multi-GB weights, so
on-device *inference* wasn't exercised end-to-end here; the abstraction, fallback, vendored
runtime, and model-presence detection were all verified.)

**Local inference is LIVE via Ollama (Phase 6).** The `.env` now defaults to
`GEMMA_BACKEND=ollama` — real Gemma running on the operator's machine (Metal/GPU), **no cloud,
no API key needed**. Verified end-to-end (browser → local Flask → local Ollama): relato +
extraction + narrative all run locally, ~6–13 s/step (faster than the cloud's 30–90 s). Setup:
`brew install ollama` → `ollama serve` → `ollama pull gemma3:4b`. `_ollama()` now passes the
same `response_schema` (Ollama structured outputs) so the ficha stays clean.
**Model-per-backend nuance (verified, not assumed):** on **Ollama**, `gemma3:4b` does text+image
but `gemma3n:e2b` is **text-only** (Ollama's build doesn't expose its vision) — so the Ollama
default is `gemma3:4b`. On **Android/LiteRT-LM**, Gemma 3n E2B is the one that does text+image+
audio. `gemma3:1b` is text-only and small but visibly weaker at anti-hallucination (invented a
name in testing) — don't use it where fidelity matters. **Server-side fallback:** with
`GEMMA_BACKEND=ollama`, if Ollama is down/refuses a request and a `GEMINI_API_KEY` exists,
`gemma_generate()` auto-falls-back to the cloud (`_gemini`) — the server-level mirror of the
browser's local-first. In the header, `backend=ollama` is shown as **local** (`📴 no
dispositivo (ollama, local)`), only `gemini` is cloud (`GemmaWeb.local`/`servidorEhLocal()`).

**Honest platform limits** (researched against official Google AI Edge docs — see
`docs/EDGE_RESEARCH.md`): the browser WebGPU path does **text + image on-device, but NOT audio**
(`config.js` `SUPPORT_AUDIO=false`) — audio-native on-device Gemma exists only on the
**Android/LiteRT-LM** path (no Android code yet). So on-device, speech still goes through ASR
(Web Speech / server fallback) and only the text reaches the on-device Gemma. Multimodal (image)
requires the big Gemma 3n E2B/E4B; small models (Gemma 3 1B/270M) are text-only. Min realistic
device: a mid-range 2023+ Android with WebGPU/GPU and ~3 GB free — hence the cloud fallback stays.

**Offline-first data path** (all verified in real Chrome, offline simulated): capture (camera +
GPS + timestamp + audio), producer registration, ficha entry, and the evidence chain all work
with **zero network**, stored in **IndexedDB**. Publishing (slug/page/QR) needs the network and
sits in a queue; `sincronizar()` is gated on `navigator.onLine`, and an `online` event listener
**auto-syncs the pending queue on reconnect** (silent — no alerts). The Config screen lists
exactly what works offline. Don't move capture/store behind a network call.

### Screens & navigation (`frontend/screens.js`) — the SPA layer (Phase 4)

A **hash-based router** (no build step, no framework) turns the app into 8 views. Each route
`#<rota>` maps to a `<section id="view-<rota>">` and a `ROTAS[rota]` loader in `screens.js`;
`navegar()` (on `hashchange` + first load, **default `#painel`**) toggles `.view.hide`, sets
the active item in the **fixed bottom navigation** (`.bottom-nav`, 5 tabs: Início/Rastrear/
Registrar[center FAB]/Denúncias/Perfil), and calls the loader. Routes without their own tab
(`lotes`→Rastrear, `cooperativa`→Perfil, `config`→gear in the top bar) highlight a parent via
`NAV_PAI`. To add a screen: add the `<section>`, a `ROTAS` entry, and (optionally) a nav item.

Every consultation screen reads the **real API** (no mocks): `painel` (`/api/resumo` +
`/api/lotes`), `lotes` (`/api/lotes`), `rastrear` (client-side filter over `/api/lotes`),
`produtores`/perfil (`/api/produtores`, `/api/produtores/<id>`), `cooperativa` (aggregates
`/api/lotes` + `/api/produtores` for the configured coop), `denuncias`
(`GET`/`POST /api/denuncias`), `config`. `registrar` is the original capture flow (`app.js`);
its `ROTAS` entry is `null` (nothing to load).

The **cooperativa is now configurable**, not hardcoded: `screens.js` owns
`window.getCooperativa()`/`setCooperativa()` (localStorage `bioamazon.coop`), the Config
screen edits it, and it threads into capture/publish via `app.js`'s `cooperativaNome()`.

**Design system (Phase 8 redesign).** Mobile-first, premium green identity. The whole look is
driven by tokens in `index.html`'s `<style>` — the `--verde-*` var **names are kept** (many
inline styles and `screens.js` reference them) with refreshed values; don't rename them, tune
values. Shared components: `.card`, `button`(+`.sec`,`.rec`), inputs/`select`/`textarea`,
`.chip` (status badges), `.stat`, `.lista`/`.lista-item`, `.cadeia`, `.tiles`/`.tile`, `.sk`
(skeleton shimmer), `.vazio`(+`.emoji`) empty states. A **real status bar** under the top bar
shows live badges driven by actual state (not mocked): `#bIa`/`#bGemma` (from `GemmaWeb`),
`#bAsr` (from `GET /api/asr_info` — whisper.cpp present?), `#bGps` (turns green on a real GPS
fix), `#net`. `#globalProgress` is an indeterminate bar shown by `app.js`'s `showProg()`/
`hideProg()` around every AI call (transcription/extract/narrate). Respect
`prefers-reduced-motion` (already handled). Keep every component functional — no decorative
mock UI.

New backend routes for these screens live in `server/app.py`: `GET /api/lotes` (list enriched
with `produtor_nome` + `evidencias_completas`), `GET /api/resumo` (dashboard counters),
`GET/POST /api/denuncias`. The `denuncias` table is in `db.py`. When adding a screen that
needs server data, add the route next to these and keep the "no mock" rule.

### Android (`android/README_LITERT.md`, `docs/EDGE_RESEARCH.md`)

No Android code exists yet in this repo — these are planning/research docs. Key decisions
already made (don't relitigate without reason): target **LiteRT-LM** for the real app
(MediaPipe `tasks-genai` is deprecated upstream); target **Gemma 3n E2B** (not E4B) to fit
mid-range devices; emulators are not reliable for this — testing needs a physical device;
audio clips are batch-only, ≤30s, no streaming. This remains the only path with true
audio-native, fully on-device Gemma inference.

### Polish pass (Phase 9) — audit fixes, dark mode, demo mode

A full audit + UX/perf/accessibility pass added several new frontend files and fixed real bugs
found by testing (not just cosmetic). Load order is now `toast.js → config.js → evidence.js →
gemma-web.js → app.js → screens.js → demo.js` (`sw.js` `SHELL` must list all of them).

**`frontend/toast.js`** — two independent IIFEs in one file: (1) `window.Toast` (`.sucesso/.erro/
.info/.aviso`), a non-blocking notification replacing every `alert()` in the app (blocking alerts
read as "prototype", not "product"); (2) a delegated ripple effect on `button, a.lista-item,
li.clicavel, .tile`. Loads first so `Toast` exists before any other script needs it.

**Real bugs fixed in this pass** (don't reintroduce): `putLote()` used to return the raw
`IDBRequest` instead of a Promise, so every `await putLote(...)` resolved instantly without
waiting for the write or surfacing failures. The record button had a race: clicking "Parar" then
immediately "Gravar" again could clobber `audioBlob`/`pipeTimes` while the previous transcription
was still in flight — now `#rec` disables itself between stop and the transcription settling.
`onRecordingStopped` now actually calls `mediaStream.getTracks().forEach(t=>t.stop())` — before,
the mic stream was never released (`media.stop()` alone doesn't do it), leaking the recording
indicator/device lock. `backend/db.py`'s `_connect()` is now a `@contextmanager` that actually
`.close()`s the sqlite3 connection (the old `with sqlite3.connect(...) as conn` idiom only
commits/rolls back — it never closes). `cli/run_poc.py` now calls `pipeline.run()` instead of
hand-duplicating extract→confirm→narrate (which meant the CLI never exercised
`estruturar_relato()`, unlike the server). Dead code removed: `pipeline.run()` was actually dead
until the run_poc fix revived it; `schema.validate()` and `transcribe.transcribe_audio()` had no
callers and were deleted outright (not deprecated/kept for "compat").

**Performance:** `db.buscar_produtor()`'s `historico` used to embed each lot's full
`evidencias_json` — including every base64 photo — even though the producer-profile screen only
ever reads produto/cooperativa/date/evidence-count from it (see `histToResumo`, now deleted
client-side since the server does the stripping). `server/app.py::_lote_resumo()` is the single
lightweight-lot-shape used by `/api/lotes`, `/api/mapa_pontos`, and now
`/api/produtores/<id>`'s `historico` — cut one real profile response from ~48 KB to ~11 KB.
`db.listar_produtores()` also had an N+1 (`SELECT COUNT(*)` per producer in a loop) replaced with
one `GROUP BY` query. If you add a new listing endpoint that touches lots, reuse `_lote_resumo`
rather than serializing `db.listar_lotes()`'s raw dicts.

**Dark mode** (`@media (prefers-color-scheme: dark)` in `index.html`'s `<style>`): only
`--bg/--card/--linha/--texto/--texto-suave/--shadow*` flip between themes. The brand/status
colors (`--verde-600/700`, `--azul`, `--laranja`, `--vermelho` and their `-bg` tints) are
**identical in both themes on purpose** — a green that reads well as text on a dark background
cannot simultaneously read well as a button background under white text (verified: no color
satisfies both ≥4.5:1 contrast requirements at once), so button/pill colors stay constant and
only the app's "frame" goes dark. Two extra tokens exist for the cases that DO need to flip:
`--verde-txt` (bright in dark mode) for green text sitting directly on `--bg`/`--card` — h2
titles, stat numbers, nav-active state, links — and `--texto-sobre-tint` (dark, constant in both
themes) for neutral labels sitting on the light `--verde-50`/`--verde-100` pill backgrounds that
don't flip (e.g. `.tile .tnome`, `.prod-info .pnome/.pmeta`). **A subtlety that cost real debug
time:** class-selector dark-mode overrides (e.g. `.topbar{background:...}`) must be declared
*after* the base rule they override in source order — `@media` blocks don't win the cascade by
virtue of being conditional, only by position/specificity, so the dark `.topbar`/`.bottom-nav`/
`.sk` overrides live in a second `@media (prefers-color-scheme: dark)` block at the very end of
the stylesheet, while the `:root` custom-property overrides (which don't have this problem —
`:root` is resolved once) stay in the first block near the top. Also watch for `background:#fff`
paired with `color:var(--texto)` — that pattern goes near-invisible in dark mode (`--texto` turns
light-on-white); fixed instances use `var(--card)` instead (identical in light mode, correct in
dark). Same-hexcode traps found live in `select/input/textarea` and `.relato-box textarea`.

**`frontend/demo.js`** (`window.DemoMode.iniciar()`, wired to `#btnDemo` in the Config screen) —
a guided walkthrough for live presentations, NOT a scripted/mocked replay: it never simulates
clicks or fabricates data. It shows a fixed bottom banner naming the current step and visually
highlights the real button to tap (`.demo-destaque`, pulsing outline), then polls real app state
every 450ms (`evidencias`, `pipeTimes`, ficha input count, narrative text, `#publicadoCard`
visibility — all read as bare globals since `app.js` has no IIFE wrapper) to auto-advance the
instant the presenter genuinely completes that step. Steps 7–8 (QR shown / "ask someone to scan
it") have no completion signal to poll, so they use a manual "Próximo" button instead.
**`.demo-banner` has `pointer-events:none`** (only its own `.demo-fechar`/`.demo-proximo` buttons
re-enable it) — found via testing that the highlighted target can end up positioned behind the
banner itself, and a non-transparent banner would silently eat the real tap meant for the button
underneath it.

**Airplane-mode testing note:** Chrome/Playwright's `context.setOffline(true)` blocks *all*
outgoing requests, including same-origin `localhost` POSTs — it does not distinguish "no
internet" from "no loopback", so it cannot be used to verify the local Ollama/whisper.cpp pipeline
(which talks to `localhost:8000`, not the internet) still works offline. `navigator.onLine` does
still correctly flip to `false` under it, which is enough to test the sync-gating logic. To
verify the AI pipeline itself needs zero internet, block everything *except*
`localhost`/`127.0.0.1` via `page.route()` instead — confirmed this way: full record→whisper→
Gemma-extract→Gemma-narrate flow completes with zero requests to any external host.

### Language

All prompts, schema field names, code comments, and the frontend/public-page UI are in
**Portuguese (pt-BR)** — this is intentional (the target users are Brazilian extractivist
producers and cooperative operators), not an inconsistency to "fix."
