"""
ASR (transcrição de fala -> texto) — DELIBERADAMENTE separado de gemma_generate.

Regra de ouro (SPEC §8): toda a INTELIGÊNCIA (extração de fatos, narrativa) passa
SEMPRE pelo Gemma. Transcrever fala NÃO é raciocínio — é só converter ondas sonoras
em texto. Depois de transcrito, o TEXTO volta para o Gemma.

ARQUITETURA LOCAL-FIRST (Edge AI) também no ASR:
  1. whisper.cpp LOCAL (offline, GPU Metal/CPU) — o objetivo. Elimina a última
     dependência de internet. Modelo ggml em backend/asr/models/.
  2. Gemini (nuvem) — FALLBACK automático, só se o whisper.cpp não estiver instalado.

No Android de produção o áudio vai DIRETO ao Gemma 3n (LiteRT-LM faz ASR nativo,
"Audio Scribe") — um só modelo transcreve e raciocina, sem whisper. Este módulo é o
equivalente offline para o caminho laptop/PWA (onde o Gemma via Ollama não aceita áudio).

Formato: whisper.cpp e a Gemini API querem WAV mono 16 kHz — o navegador já converte
(frontend/gemma-web.js::toWavMono). Sem dependência de ffmpeg.
"""
from __future__ import annotations
import mimetypes
import os
import shutil
import subprocess
import time

# Reusa o carregador de .env e a chave já resolvidos pelo módulo do Gemma.
from backend.gemma.gemma_generate import GEMINI_API_KEY

# --- whisper.cpp (LOCAL) ---
WHISPER_BIN = os.environ.get("WHISPER_BIN", "whisper-cli")
WHISPER_MODEL = os.environ.get(
    "WHISPER_MODEL",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "ggml-small.bin"),
)
WHISPER_LANG = os.environ.get("WHISPER_LANG", "pt")

# --- Gemini (NUVEM, fallback) ---
GEMINI_ASR_MODEL = os.environ.get("GEMINI_ASR_MODEL", "gemini-flash-latest")
_ASR_PROMPT = (
    "Transcreva EXATAMENTE o que é falado neste áudio, em português do Brasil. "
    "Não traduza, não resuma, não comente: devolva apenas a transcrição literal. "
    "Se não houver fala audível, devolva uma string vazia."
)


def whisper_disponivel() -> bool:
    return bool(shutil.which(WHISPER_BIN)) and os.path.isfile(WHISPER_MODEL)


def _transcrever_local(audio_path: str) -> str:
    """whisper.cpp, 100% offline. stdout = transcrição (logs vão pro stderr)."""
    proc = subprocess.run(
        [WHISPER_BIN, "-m", WHISPER_MODEL, "-f", audio_path,
         "-l", WHISPER_LANG, "-nt", "-np"],
        capture_output=True, text=True, timeout=300,
    )
    if proc.returncode != 0:
        raise RuntimeError("whisper.cpp falhou: " + (proc.stderr or "")[-300:])
    return proc.stdout.strip()


def _transcrever_nuvem(audio_path: str) -> str:
    if not GEMINI_API_KEY:
        raise RuntimeError(
            "Sem whisper.cpp local e sem GEMINI_API_KEY — não há como transcrever. "
            "Instale o whisper.cpp (ASR offline) ou configure a chave de nuvem."
        )
    from google import genai
    from google.genai import types
    with open(audio_path, "rb") as f:
        data = f.read()
    mime = mimetypes.guess_type(audio_path)[0] or "audio/wav"
    client = genai.Client(api_key=GEMINI_API_KEY)
    resp = client.models.generate_content(
        model=GEMINI_ASR_MODEL,
        contents=[types.Part.from_text(text=_ASR_PROMPT),
                  types.Part.from_bytes(data=data, mime_type=mime)],
        config=types.GenerateContentConfig(temperature=0.0, max_output_tokens=2048),
    )
    return (resp.text or "").strip()


def transcribe(audio_path: str) -> dict:
    """LOCAL-FIRST: whisper.cpp offline; se ausente, cai na nuvem. Devolve também o
    MOTOR usado e o TEMPO (ms) — para demonstrar/medir a pipeline offline."""
    t0 = time.time()
    if whisper_disponivel():
        texto = _transcrever_local(audio_path)
        engine = "whisper.cpp (local, offline)"
    else:
        texto = _transcrever_nuvem(audio_path)
        engine = "gemini (nuvem, fallback)"
    return {"transcript": texto, "engine": engine, "ms": int((time.time() - t0) * 1000)}
