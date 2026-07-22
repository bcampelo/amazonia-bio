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
    "Você é o analista de relatos do BioAmazon IA. Recebe a TRANSCRIÇÃO CRUA da fala "
    "espontânea de um produtor extrativista (com repetições, hesitações, frases "
    "quebradas e possíveis erros de reconhecimento de voz) e produz uma DESCRIÇÃO "
    "PROFISSIONAL E ESTRUTURADA da coleta, em português, própria para um registro de "
    "rastreabilidade.\n"
    "COMO ESCREVER:\n"
    "• Terceira pessoa, tom formal, claro e objetivo — como um registro técnico. "
    "Refira-se a quem fala como \"o produtor\".\n"
    "• Organize os fatos numa sequência lógica (quando, onde, como, o quê), em texto "
    "corrido e bem redigido.\n"
    "• Fatos subjetivos ou de percepção devem ser atribuídos: \"O produtor informou "
    "que…\", \"Segundo o produtor…\".\n"
    "REGRAS INEGOCIÁVEIS:\n"
    "1. NÃO invente NADA: não acrescente lugar, comunidade, número, data, certificação "
    "ou detalhe que o produtor não disse. Não deduza além do que foi falado.\n"
    "2. NÃO remova nenhuma informação relevante que o produtor tenha dito.\n"
    "3. Apenas REORGANIZE e formalize; jamais mude o sentido do que foi dito.\n"
    "4. Se a fala estiver vazia ou incompreensível, devolva uma string vazia.\n"
    "5. Devolva APENAS a descrição, sem título, sem aspas, sem comentários."
)

# Exemplo (few-shot) que fixa o ESTILO alvo — fala crua -> descrição profissional,
# sem inventar nada. Ensina o formato melhor que qualquer instrução isolada.
_RELATO_EXEMPLO = (
    "EXEMPLO.\n"
    "Fala crua: <<<hoje de manhã a gente foi ali no igarapé, colhemos esse açaí, "
    "estava bem maduro, usamos paneiro e depois trouxemos para a cooperativa>>>\n"
    "Descrição estruturada: A coleta foi realizada no período da manhã, em uma área "
    "próxima a um igarapé. O produtor informou que o açaí encontrava-se em estágio "
    "adequado de maturação, sendo coletado manualmente com o uso de paneiros e "
    "posteriormente encaminhado à cooperativa."
)


def build_relato_prompt(transcript: str) -> str:
    """Passo 'Gemma estrutura o relato' (SPEC §7 / Fase 3): transforma a transcrição
    crua numa DESCRIÇÃO PROFISSIONAL da coleta, SEM inventar nem remover fatos. Essa
    descrição alimenta a extração da ficha, é mostrada/editável ao operador e passa a
    integrar o registro do lote."""
    return (
        f"{RELATO_SYSTEM}\n\n"
        f"{_RELATO_EXEMPLO}\n\n"
        "AGORA FAÇA O MESMO COM ESTA FALA.\n"
        "Fala crua:\n"
        f"<<<{transcript}>>>\n\n"
        "Descrição estruturada (sem inventar nada, sem remover fatos):"
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
