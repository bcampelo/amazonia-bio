"""
gemma_generate — ÚNICO ponto de contato com o Gemma (model-agnostic, backend-agnostic).

Princípio da SPEC (§8/§16): toda a inteligência passa por esta função.
Trocar de runtime (mock -> gemini -> ollama local -> LiteRT no Android) NÃO muda o
resto do código.

Backends suportados nesta PoC:
  - "mock"   : sem rede, sem pesos. Prova o PIPELINE (fluxo + schema + proveniência).
  - "gemini" : Gemma REAL hospedado via Gemini API (SDK oficial google-genai).
               Requer GEMINI_API_KEY (grátis em aistudio.google.com/app/apikey).
  - "ollama" : Gemma REAL rodando localmente (http://localhost:11434). Edge/offline.

O backend do Android (LiteRT-LM / Kotlin) implementa exatamente a mesma assinatura
no app; ver android/README_LITERT.md. Aqui deixamos o contrato definido.
"""
from __future__ import annotations
import os
import re
import json
import base64
import mimetypes
import urllib.request
from typing import Optional, List


def _load_dotenv() -> None:
    """Carrega .env (se existir) sem exigir dependência extra (python-dotenv)."""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))), ".env")
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()

DEFAULT_BACKEND = os.environ.get("GEMMA_BACKEND", "mock")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
GEMMA_MODEL = os.environ.get("GEMMA_MODEL", "gemma3n:e2b")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemma-4-26b-a4b-it")


def gemma_generate(
    prompt: str,
    *,
    images: Optional[List[str]] = None,   # caminhos de arquivo de imagem
    audio: Optional[str] = None,          # caminho de arquivo de áudio (.wav mono)
    backend: Optional[str] = None,
    temperature: float = 0.2,
    max_tokens: int = 1024,
    json_mode: bool = False,
    response_schema: Optional[dict] = None,
) -> str:
    """Recebe um prompt (texto) + mídia opcional, devolve texto do Gemma.

    response_schema: dict (JSON-Schema simplificado) para forçar SAÍDA ESTRUTURADA
    nos backends que suportam (só o gemini hoje). Reduz drasticamente JSON truncado/
    sujo. Ignorado pelos backends que não suportam."""
    backend = backend or DEFAULT_BACKEND
    if backend == "gemini":
        return _gemini(prompt, images, temperature, max_tokens, json_mode, response_schema)
    if backend == "ollama":
        return _ollama(prompt, images, audio, temperature, max_tokens, json_mode)
    if backend == "mock":
        return _mock(prompt, json_mode)
    raise ValueError(f"Backend desconhecido: {backend!r} (use 'mock', 'gemini' ou 'ollama')")


# --------------------------------------------------------------------------- #
# Backend REAL: Gemini API (Gemma hospedado — SDK oficial google-genai)
# --------------------------------------------------------------------------- #
def _gemini(prompt, images, temperature, max_tokens, json_mode, response_schema=None) -> str:
    if not GEMINI_API_KEY:
        raise RuntimeError(
            "GEMINI_API_KEY não configurada. Crie uma grátis em "
            "https://aistudio.google.com/app/apikey e exporte GEMINI_API_KEY "
            "(ou coloque num arquivo .env na raiz do projeto)."
        )
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=GEMINI_API_KEY)
    parts = [types.Part.from_text(text=prompt)]
    for img in (images or []):
        if not img:
            continue
        with open(img, "rb") as f:
            data = f.read()
        mime = mimetypes.guess_type(img)[0] or "image/jpeg"
        parts.append(types.Part.from_bytes(data=data, mime_type=mime))

    # gemma-4-*-it "pensa" antes de responder e não permite desligar o thinking
    # (thinking_budget não é suportado); sem folga o raciocínio consome todo o
    # max_tokens e a resposta final vem vazia. Garantimos um piso de budget.
    config = types.GenerateContentConfig(
        temperature=temperature,
        max_output_tokens=max(max_tokens, 2048),
        response_mime_type="application/json" if json_mode else None,
        # Structured output: quando o chamador fornece um schema, o modelo é obrigado
        # a devolver exatamente essa forma. Verificado que o Gemma via Gemini API
        # respeita — e assim não trunca a ficha nem devolve texto fora do JSON.
        response_schema=response_schema if json_mode else None,
    )
    response = client.models.generate_content(
        model=GEMINI_MODEL, contents=parts, config=config,
    )
    return response.text or ""


# --------------------------------------------------------------------------- #
# Backend REAL: Ollama local (Gemma no dispositivo / máquina do operador)
# --------------------------------------------------------------------------- #
def _ollama(prompt, images, audio, temperature, max_tokens, json_mode) -> str:
    payload = {
        "model": GEMMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": temperature, "num_predict": max_tokens},
    }
    if json_mode:
        payload["format"] = "json"
    if images:
        payload["images"] = [_b64(p) for p in images]
    # Nota: áudio no Ollama ainda é limitado; no Android o áudio vai direto ao
    # Gemma 3n via LiteRT-LM. Ver docs/EDGE_RESEARCH.md (Plano B de ASR).
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read().decode("utf-8")).get("response", "")


def _b64(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


# --------------------------------------------------------------------------- #
# Backend MOCK: prova o pipeline sem rede/pesos. Determinístico.
# Extração faz um "parsing ingênuo" do transcript para parecer real e para
# demonstrar a marcação de PROVENIÊNCIA (audio vs inferido).
# --------------------------------------------------------------------------- #
def _mock(prompt: str, json_mode: bool) -> str:
    if json_mode:
        return json.dumps(_mock_ficha(prompt), ensure_ascii=False)
    return _mock_narrativa(prompt)


def _field(value, prov):
    return {"value": value, "provenance": prov}


def _mock_ficha(prompt: str) -> dict:
    # O transcript foi embutido no prompt entre <<< >>>.
    m = re.search(r"<<<(.+?)>>>", prompt, re.S)
    t = (m.group(1) if m else prompt).lower()

    def found(*words):
        return any(w in t for w in words)

    volume = None
    mv = re.search(r"(\d+)\s*(kg|quilos|latas?)", t)
    if mv:
        volume = mv.group(1)

    comunidade = "não informado"
    for c in ["chico mendes", "resex", "xapuri", "brasil[ée]ia", "cazumb[aá]"]:
        mc = re.search(c, t)
        if mc:
            comunidade = mc.group(0).title()
            break

    return {
        "produto": _field("Açaí", "imagem" if found("açaí", "acai") else "inferido"),
        "variedade": _field("Açaí-solteiro (Euterpe precatoria)"
                            if found("solteiro", "precatoria") else "não informado",
                            "audio" if found("solteiro") else "inferido"),
        "origem": _field(comunidade, "audio" if comunidade != "não informado" else "inferido"),
        "metodo_coleta_manejo": _field(
            "Coleta manual, escalada de palmeira nativa em floresta em pé"
            if found("escal", "subi", "manual", "mão") else "coleta extrativista",
            "audio" if found("escal", "subi", "manual") else "inferido"),
        "epoca_safra": _field(
            next((mo for mo in ["janeiro","fevereiro","março","abril","maio","junho",
                                "julho","agosto","setembro","outubro","novembro","dezembro"]
                  if mo in t), "safra amazônica (varia por região)"),
            "audio" if any(mo in t for mo in ["janeiro","fevereiro","março"]) else "inferido"),
        "caracteristicas_sensoriais": _field(
            "Polpa encorpada, cor roxa intensa, sabor amazônico" , "inferido"),
        "praticas_sustentaveis": _field(
            "Extrativismo de floresta em pé, sem desmatamento"
            if found("floresta", "sem desmat", "nativ") else "não informado",
            "audio" if found("floresta", "nativ") else "inferido"),
        "volume": _field(volume or "não informado",
                         "audio" if volume else "inferido"),
        "unidade": _field("kg" if found("kg", "quilos") else "lata", "inferido"),
    }


def _mock_narrativa(prompt: str) -> str:
    coop = "a cooperativa"
    mc = re.search(r"cooperativa[:\s]+([A-Za-zÀ-ÿ ]+)", prompt)
    if mc:
        coop = mc.group(1).strip()
    return (
        "Desta floresta em pé nasce um açaí com nome e origem. Colhido à mão por "
        "extrativistas que conhecem cada palmeira, o fruto carrega a história de um "
        "território que se mantém vivo justamente porque tem valor. "
        f"Atestado por {coop}, este lote chega até você com sua jornada registrada — "
        "do pé ao ponto de venda — como prova de que a floresta vale mais em pé.\n\n"
        "[narrativa gerada pelo Gemma a partir apenas dos fatos confirmados]"
    )
