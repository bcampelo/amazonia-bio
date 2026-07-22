"""
ASR (transcrição de fala -> texto) — DELIBERADAMENTE separado de gemma_generate.

Por quê um módulo à parte e não mais um "backend" do Gemma?
    A regra de ouro do projeto (ver CLAUDE.md / SPEC §8) é: toda a INTELIGÊNCIA
    (extração de fatos e geração de narrativa) passa SEMPRE pelo Gemma. Transcrever
    fala não é raciocínio — é só converter ondas sonoras em texto. Já existia uma
    exceção documentada para isso no caminho do navegador (Web Speech API). Este
    módulo é o espelho dessa exceção no SERVIDOR, para os casos em que o ASR do
    navegador não existe/falha (Safari, Brave, Firefox, sem rede do Google, etc.).

    Mantê-lo fora de gemma_generate.py é intencional: ninguém deve confundir ASR
    com o Gemma. Depois de transcrito, o TEXTO volta para o Gemma, que continua
    fazendo 100% da extração e da narrativa.

Limitação real que motiva este módulo:
    O Gemma hospedado via Gemini API (gemma-4-*-it) REJEITA áudio
    ("Audio input modality is not enabled for this model"). Logo, o próprio Gemma
    não pode transcrever. Usamos aqui um modelo Gemini multimodal comum
    (gemini-flash-latest por padrão) SÓ como serviço de ASR. Verificado ao vivo:
    transcreve pt-BR corretamente a partir de WAV mono 16 kHz.

Formato de áudio:
    A Gemini API aceita WAV/MP3/AIFF/AAC/OGG/FLAC — NÃO o webm/opus cru do
    MediaRecorder. Por isso o navegador converte para WAV mono antes de enviar
    (frontend/gemma-web.js::toWavMono). Não há dependência de ffmpeg no servidor.
"""
from __future__ import annotations
import mimetypes
import os

# Reusa o carregador de .env e a chave já resolvidos pelo módulo do Gemma —
# sem duplicar parsing de ambiente.
from backend.gemma.gemma_generate import GEMINI_API_KEY

GEMINI_ASR_MODEL = os.environ.get("GEMINI_ASR_MODEL", "gemini-flash-latest")

_ASR_PROMPT = (
    "Transcreva EXATAMENTE o que é falado neste áudio, em português do Brasil. "
    "Não traduza, não resuma, não comente, não corrija o conteúdo: devolva apenas "
    "a transcrição literal da fala. Se não houver fala audível, devolva uma string "
    "vazia."
)


def transcribe_audio(audio_path: str) -> str:
    """Recebe o caminho de um arquivo de áudio (WAV mono de preferência) e
    devolve a transcrição em texto. Levanta RuntimeError com mensagem clara se a
    chave não estiver configurada ou a API falhar."""
    if not GEMINI_API_KEY:
        raise RuntimeError(
            "GEMINI_API_KEY não configurada — o fallback de transcrição no servidor "
            "precisa dela. Crie grátis em https://aistudio.google.com/app/apikey."
        )
    from google import genai
    from google.genai import types

    with open(audio_path, "rb") as f:
        data = f.read()
    mime = mimetypes.guess_type(audio_path)[0] or "audio/wav"

    client = genai.Client(api_key=GEMINI_API_KEY)
    response = client.models.generate_content(
        model=GEMINI_ASR_MODEL,
        contents=[
            types.Part.from_text(text=_ASR_PROMPT),
            types.Part.from_bytes(data=data, mime_type=mime),
        ],
        config=types.GenerateContentConfig(temperature=0.0, max_output_tokens=2048),
    )
    return (response.text or "").strip()
