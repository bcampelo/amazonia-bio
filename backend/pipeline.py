"""
Orquestração das DUAS PASSAGENS (SPEC §8), rodando no dispositivo.
extract -> [confirmação do operador] -> narrate.
Nenhuma rede necessária: o Gemma roda local; o servidor só entra na publicação.
"""
from __future__ import annotations
import json
from typing import Optional

from backend.gemma.gemma_generate import gemma_generate
from backend.extraction.prompt import build_extraction_prompt
from backend.narrative.prompt import build_narrative_prompt
from backend.extraction.schema import FICHA_FIELDS, PROVENANCES, empty_ficha


def extract(transcript: str, image: Optional[str] = None,
            backend: Optional[str] = None) -> dict:
    """Passagem 1: áudio(transcrito)+imagem -> ficha JSON estruturada."""
    prompt = build_extraction_prompt(transcript, has_image=bool(image))
    raw = gemma_generate(
        prompt, images=[image] if image else None,
        backend=backend, temperature=0.1, json_mode=True,
    )
    try:
        ficha = json.loads(raw)
    except json.JSONDecodeError:
        # degradação: modelo devolveu texto sujo -> tenta recortar o 1º objeto JSON
        start, end = raw.find("{"), raw.rfind("}")
        ficha = json.loads(raw[start:end + 1]) if start >= 0 else empty_ficha()
    return _sanitize(ficha)


def _sanitize(ficha: dict) -> dict:
    """Garante os 9 campos e uma proveniência válida por campo. O Gemma às vezes
    usa "não informado" também como proveniência (deveria ser só o value) —
    aqui isso é corrigido campo a campo, em vez de descartar a ficha inteira."""
    base = empty_ficha()
    for f in FICHA_FIELDS:
        cell = ficha.get(f)
        if isinstance(cell, dict) and "value" in cell:
            prov = cell.get("provenance")
            base[f] = {
                "value": cell["value"],
                "provenance": prov if prov in PROVENANCES else "inferido",
            }
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
    """Passagem 2: fatos confirmados -> narrativa rotulada como gerada."""
    prompt = build_narrative_prompt(confirmed_ficha, cooperativa)
    return gemma_generate(prompt, backend=backend, temperature=0.6, max_tokens=400)


def run(transcript: str, cooperativa: str, image: Optional[str] = None,
        overrides: Optional[dict] = None, backend: Optional[str] = None) -> dict:
    ficha = extract(transcript, image=image, backend=backend)
    confirmada = confirm(ficha, overrides)
    narrativa = narrate(confirmada, cooperativa, backend=backend)
    return {"ficha_extraida": ficha, "ficha_confirmada": confirmada,
            "narrativa": narrativa, "cooperativa": cooperativa}
