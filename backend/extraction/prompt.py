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
    "extrativista (texto, em português) e de uma FOTO do produto, você extrai fatos "
    "objetivos e devolve APENAS um JSON válido, sem texto fora do JSON.\n"
    "COMO PREENCHER (aproveite ao máximo o que a fala e a foto oferecem):\n"
    "• Se o produto está VISÍVEL na foto (ex.: reconhece açaí, castanha, cupuaçu), "
    "preencha \"produto\" com confiança e marque proveniência \"imagem\".\n"
    "• Descreva em \"caracteristicas_sensoriais\" o que é VISÍVEL na foto (cor, aspecto, "
    "textura aparente) — proveniência \"imagem\". Sabor e aroma só se ditos na fala.\n"
    "• Tudo que o produtor DIZ na fala (variedade, método de coleta, época, volume, "
    "unidade, práticas) preencha e marque \"audio\".\n"
    "• Quando um fato é uma dedução técnica segura (ex.: nome científico de uma "
    "variedade que o produtor citou pelo nome popular), preencha e marque \"inferido\".\n"
    "REGRAS INEGOCIÁVEIS (anti-alucinação):\n"
    "1. NUNCA invente origem, comunidade, cidade, certificação, selo, número ou data. "
    "Esses SÓ podem vir se ditos na fala ou legíveis na foto. Se não, use \"não informado\".\n"
    "2. Não confunda dedução com invenção: preencher a cor de um açaí visível é dedução "
    "válida; preencher a comunidade de origem sem ela ter sido dita é invenção proibida.\n"
    "3. Marque a PROVENIÊNCIA de cada campo: \"audio\", \"imagem\" ou \"inferido\".\n"
    "4. Não gere narrativa nem marketing aqui. Só fatos estruturados."
)


RELATO_SYSTEM = (
    "Você é o organizador de relatos do BioAmazon IA. Recebe a TRANSCRIÇÃO CRUA da "
    "fala de um produtor extrativista (pode vir com repetições, hesitações, frases "
    "quebradas e erros de reconhecimento de voz) e reescreve como um relato claro, "
    "em português, em 1ª pessoa, bem organizado.\n"
    "REGRAS INEGOCIÁVEIS:\n"
    "1. NÃO invente NENHUM fato: não acrescente lugar, comunidade, número, data, "
    "certificação ou detalhe que o produtor não disse. Só organize o que já está lá.\n"
    "2. Preserve EXATAMENTE o significado. Pode corrigir gramática e ordenar as ideias, "
    "mas nunca mude o sentido do que foi dito.\n"
    "3. Se a fala estiver vazia ou incompreensível, devolva uma string vazia.\n"
    "4. Devolva APENAS o relato reescrito, sem título, sem aspas, sem comentários."
)


def build_relato_prompt(transcript: str) -> str:
    """Passo 'Gemma reorganiza o relato' (SPEC §7 / fluxo de áudio): transforma a
    transcrição crua num relato limpo, SEM inventar nada. Esse relato organizado é
    o que alimenta a extração da ficha e também é mostrado ao operador."""
    return (
        f"{RELATO_SYSTEM}\n\n"
        "TRANSCRIÇÃO CRUA DA FALA:\n"
        f"<<<{transcript}>>>\n\n"
        "Reescreva o relato do produtor de forma clara e organizada, "
        "sem inventar nada:"
    )


def build_extraction_prompt(transcript: str, has_image: bool) -> str:
    img_line = ("Há uma FOTO do produto anexada a este prompt. Observe-a com atenção e "
                "preencha com confiança os campos visíveis (produto, cor/aspecto em "
                "caracteristicas_sensoriais)." if has_image
                else "Não há foto anexada; marque campos puramente visuais como "
                "\"não informado\", a menos que ditos na fala.")
    fala = transcript.strip() or "(o produtor não falou nada / transcrição vazia)"
    return (
        f"{EXTRACTION_SYSTEM}\n\n"
        f"{img_line}\n\n"
        "RELATO DO PRODUTOR (organizado a partir da fala):\n"
        f"<<<{fala}>>>\n\n"
        "Devolva um JSON com EXATAMENTE estes campos, cada um no formato "
        '{\"value\": \"...\", \"provenance\": \"audio|imagem|inferido\"}:\n'
        f"{_CAMPOS}\n"
    )
