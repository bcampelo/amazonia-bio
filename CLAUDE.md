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
transcription (ASR), which is not reasoning, just turning sound into text. There are now
**two** ASR paths, both outside `gemma_generate` on purpose: (1) the browser Web Speech API
(primary, on-device, in `frontend/app.js`); (2) a **server-side fallback**,
`backend/asr/transcribe.py::transcribe_audio()`, used when the browser has no/failed ASR
(Safari, Brave, Firefox, no Google backend). The server fallback calls a plain Gemini
multimodal model (`GEMINI_ASR_MODEL`, default `gemini-flash-latest`) **only to transcribe** —
Gemma still does 100% of extraction/narrative. It lives in its own `backend/asr/` package,
NOT as a `gemma_generate` backend, precisely so nobody confuses ASR with the Gemma brain.

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
→ `gemma-web.js` (backend selection + inference calls) → `app.js` (UI wiring, capture,
IndexedDB, sync). `sw.js` caches the app shell for offline use.

`gemma-web.js`'s `init()` picks a mode in this priority order: **`server`** (calls
`/api/health`; if reachable, real Gemma via `server/app.py` — the expected path whenever the
Flask server is running) → **`webgpu`** (on-device MediaPipe `tasks-genai`, needs a
`.litertlm` file in `frontend/models/` that isn't present in this repo — effectively dormant
until someone supplies one) → **`"indisponivel"`**. **There is no mock fallback anymore —
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

### Android (`android/README_LITERT.md`, `docs/EDGE_RESEARCH.md`)

No Android code exists yet in this repo — these are planning/research docs. Key decisions
already made (don't relitigate without reason): target **LiteRT-LM** for the real app
(MediaPipe `tasks-genai` is deprecated upstream); target **Gemma 3n E2B** (not E4B) to fit
mid-range devices; emulators are not reliable for this — testing needs a physical device;
audio clips are batch-only, ≤30s, no streaming. This remains the only path with true
audio-native, fully on-device Gemma inference.

### Language

All prompts, schema field names, code comments, and the frontend/public-page UI are in
**Portuguese (pt-BR)** — this is intentional (the target users are Brazilian extractivist
producers and cooperative operators), not an inconsistency to "fix."
