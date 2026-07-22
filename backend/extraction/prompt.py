"""
Passagem 1 — EXTRAÇÃO (SPEC §7.4).
Constrói o prompt multimodal que instrui o Gemma a devolver a ficha em JSON.
Regras-chave: temperatura baixa, SÓ JSON, proveniência por campo, NÃO inventar
origem nem certificação (anti-alucinação — §16.4).

Os prompts são independentes de runtime: valem igual no mock, no Ollama e no
LiteRT-LM do Android. É a "IP" reaproveitável do projeto.
"""
from __future__ import annotations
from backend.extraction.schema import FICHA_FIELDS

_CAMPOS = "\n".join(f'  - {c}' for c in FICHA_FIELDS)

EXTRACTION_SYSTEM = (
    "Você é o motor de extração do BioAmazon IA. A partir da FALA de um produtor "
    "extrativista (áudio, em português) e de uma FOTO do produto, você extrai fatos "
    "objetivos e devolve APENAS um JSON válido, sem texto fora do JSON.\n"
    "REGRAS INEGOCIÁVEIS:\n"
    "1. NUNCA invente origem, comunidade, certificação, selo ou número. Se não foi dito "
    "nem é visível, use \"não informado\".\n"
    "2. Marque a PROVENIÊNCIA de cada campo: \"audio\" (dito na fala), \"imagem\" (visível "
    "na foto) ou \"inferido\" (deduzido com cautela).\n"
    "3. Não gere narrativa nem marketing aqui. Só fatos estruturados."
)


def build_extraction_prompt(transcript: str, has_image: bool) -> str:
    img_line = ("Há uma FOTO do produto anexada a este prompt; use-a para os campos "
                "visíveis (ex.: produto, características)." if has_image
                else "Não há foto; marque campos visuais como \"inferido\" ou \"não informado\".")
    return (
        f"{EXTRACTION_SYSTEM}\n\n"
        f"{img_line}\n\n"
        "FALA DO PRODUTOR (transcrição do áudio):\n"
        f"<<<{transcript}>>>\n\n"
        "Devolva um JSON com EXATAMENTE estes campos, cada um no formato "
        '{\"value\": \"...\", \"provenance\": \"audio|imagem|inferido\"}:\n'
        f"{_CAMPOS}\n"
    )
