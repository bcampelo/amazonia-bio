"""
Schema da FichaTecnica (SPEC §11) + validação leve (sem dependências externas).

Cada campo é um objeto { "value": <str>, "provenance": <proveniência> } onde
proveniência ∈ { audio, imagem, inferido, confirmado }.
A marcação de proveniência é o que sustenta a confiança da rastreabilidade:
o Gemma DECLARA de onde tirou cada fato; o operador CONFIRMA (§4/§16).
"""
from __future__ import annotations

FICHA_FIELDS = [
    "produto",
    "variedade",
    "origem",
    "metodo_coleta_manejo",
    "epoca_safra",
    "caracteristicas_sensoriais",
    "praticas_sustentaveis",
    "volume",
    "unidade",
]

PROVENANCES = {"audio", "imagem", "inferido", "confirmado"}


def empty_ficha() -> dict:
    return {f: {"value": "não informado", "provenance": "inferido"} for f in FICHA_FIELDS}


def validate(ficha: dict) -> tuple[bool, list[str]]:
    errors: list[str] = []
    for f in FICHA_FIELDS:
        if f not in ficha:
            errors.append(f"campo ausente: {f}")
            continue
        cell = ficha[f]
        if not isinstance(cell, dict) or "value" not in cell or "provenance" not in cell:
            errors.append(f"campo malformado (esperado {{value, provenance}}): {f}")
            continue
        if cell["provenance"] not in PROVENANCES:
            errors.append(f"proveniência inválida em {f}: {cell['provenance']!r}")
    extra = [k for k in ficha if k not in FICHA_FIELDS]
    if extra:
        errors.append(f"campos inesperados (ignoráveis): {extra}")
    return (len([e for e in errors if 'inesperados' not in e]) == 0, errors)
