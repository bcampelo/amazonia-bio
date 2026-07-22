"""
Orquestração das DUAS PASSAGENS (SPEC §8), rodando no dispositivo.
extract -> [confirmação do operador] -> narrate.
Nenhuma rede necessária: o Gemma roda local; o servidor só entra na publicação.
"""
from __future__ import annotations
import json
from typing import Optional

from backend.gemma.gemma_generate import gemma_generate
from backend.extraction.prompt import build_extraction_prompt, build_relato_prompt
from backend.narrative.prompt import build_narrative_prompt
from backend.extraction.schema import (
    FICHA_FIELDS, PROVENANCES, empty_ficha, ficha_response_schema,
)


def estruturar_relato(transcript: str, backend: Optional[str] = None) -> str:
    """Passo intermediário do fluxo de áudio (SPEC §7): o Gemma reorganiza a
    TRANSCRIÇÃO CRUA (com hesitações/erros de ASR) num relato limpo, SEM inventar
    nada. É o Gemma quem faz — não é regra/heurística. Devolve a transcrição
    original se estiver vazia ou se a reorganização vier vazia (nunca perde a fala)."""
    transcript = (transcript or "").strip()
    if not transcript:
        return ""
    organizado = gemma_generate(
        build_relato_prompt(transcript), backend=backend,
        temperature=0.2, max_tokens=4096,  # folga p/ o "pensamento" não zerar a saída
    ).strip()
    return organizado or transcript


def extract(transcript: str, image: Optional[str] = None,
            backend: Optional[str] = None) -> dict:
    """Passagem 1: relato(texto)+imagem -> ficha JSON estruturada.

    Usa structured output (response_schema) para o modelo não truncar nem devolver
    texto fora do JSON — a causa real de campos virem vazios/quebrarem antes."""
    prompt = build_extraction_prompt(transcript, has_image=bool(image))
    raw = gemma_generate(
        prompt, images=[image] if image else None,
        backend=backend, temperature=0.1, json_mode=True,
        max_tokens=3072, response_schema=ficha_response_schema(),
    )
    ficha = _parse_ficha(raw)
    return _sanitize(ficha)


def _parse_ficha(raw: str) -> dict:
    """Parse tolerante: JSON limpo -> recorte do 1º objeto -> ficha vazia.
    NUNCA levanta exceção (uma resposta truncada não pode derrubar /api/extrair);
    no pior caso devolve empty_ficha() e o operador preenche na revisão."""
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        pass
    start, end = raw.find("{"), raw.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(raw[start:end + 1])
        except json.JSONDecodeError:
            pass
    return empty_ficha()


def _sanitize(ficha: dict) -> dict:
    """Garante os 9 campos e uma proveniência válida por campo. O Gemma às vezes
    usa "não informado" também como proveniência (deveria ser só o value) —
    aqui isso é corrigido campo a campo, em vez de descartar a ficha inteira."""
    base = empty_ficha()
    for f in FICHA_FIELDS:
        cell = ficha.get(f)
        if isinstance(cell, dict) and "value" in cell:
            value = (str(cell["value"]).strip() if cell["value"] is not None
                     else "não informado") or "não informado"
            prov = cell.get("provenance")
            prov = prov if prov in PROVENANCES else "inferido"
            # consistência: um fato ausente não pode alegar fonte "audio"/"imagem".
            if value == "não informado":
                prov = "inferido"
            base[f] = {"value": value, "provenance": prov}
    return base


def confirm(ficha: dict, overrides: Optional[dict] = None) -> dict:
    """Loop de confiança (§7.5): operador confirma/corrige. Marca proveniência
    'confirmado' no que passou pela revisão humana."""
    overrides = overrides or {}
    out = {}
    for k, cell in ficha.items():
        value = overrides.get(k, cell.get("value"))
        prov = "confirmado"
        out[k] = {"value": value, "provenance": prov}
    return out


def narrate(confirmed_ficha: dict, cooperativa: str,
            backend: Optional[str] = None) -> str:
    """Passagem 2: fatos confirmados -> narrativa rotulada como gerada.

    max_tokens generoso de PROPÓSITO: os modelos gemma-4-*-it "pensam" antes de
    responder (não dá pra desligar) e o raciocínio varia — com pouco orçamento ele
    consome tudo e a narrativa volta VAZIA (bug real observado com 2048). O teto
    alto não deixa mais lento (o modelo para sozinho ao terminar), só garante que
    sobre espaço para o texto final."""
    prompt = build_narrative_prompt(confirmed_ficha, cooperativa)
    return gemma_generate(prompt, backend=backend, temperature=0.6, max_tokens=8192)


def run(transcript: str, cooperativa: str, image: Optional[str] = None,
        overrides: Optional[dict] = None, backend: Optional[str] = None) -> dict:
    relato = estruturar_relato(transcript, backend=backend)
    ficha = extract(relato or transcript, image=image, backend=backend)
    confirmada = confirm(ficha, overrides)
    narrativa = narrate(confirmada, cooperativa, backend=backend)
    return {"relato": relato, "ficha_extraida": ficha,
            "ficha_confirmada": confirmada, "narrativa": narrativa,
            "cooperativa": cooperativa}
