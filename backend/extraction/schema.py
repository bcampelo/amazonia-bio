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


# Proveniências que a EXTRAÇÃO pode emitir (o operador é quem carimba "confirmado"
# depois, no loop de confiança — por isso ele fica fora do enum de extração).
_EXTRACTION_PROVENANCES = ["audio", "imagem", "inferido"]


def ficha_response_schema() -> dict:
    """Schema (JSON-Schema/OpenAPI simplificado, dict puro e agnóstico de runtime)
    para forçar a SAÍDA ESTRUTURADA do modelo. Passado ao backend que suporta
    structured output (ver _gemini). Elimina "texto fora do JSON" e trunca menos —
    o que fazia campos virem vazios antes. FICHA_FIELDS é a fonte da verdade."""
    cell = {
        "type": "object",
        "properties": {
            "value": {"type": "string"},
            "provenance": {"type": "string", "enum": _EXTRACTION_PROVENANCES},
        },
        "required": ["value", "provenance"],
    }
    return {
        "type": "object",
        "properties": {f: cell for f in FICHA_FIELDS},
        "required": list(FICHA_FIELDS),
        "propertyOrdering": list(FICHA_FIELDS),
    }
