"""
Passagem 2 — GERAÇÃO da narrativa/jornada (SPEC §7.6).
Regra central: usa APENAS fatos confirmados. Fato e narrativa ficam separados.
O texto é rotulado como gerado. O Gemma traduz/estrutura; não inventa origem.
"""
from __future__ import annotations


def build_narrative_prompt(confirmed_ficha: dict, cooperativa: str) -> str:
    fatos = "\n".join(
        f"  - {k}: {v['value']} (fonte: {v['provenance']})"
        for k, v in confirmed_ficha.items()
        if v.get("value") and v["value"] != "não informado"
    )
    return (
        "Você é o motor narrativo do BioAmazon IA. Escreva, em português, uma "
        "jornada curta (3 a 5 frases, em texto corrido) que valorize este produto da "
        "sociobiodiversidade para um comprador consciente.\n"
        "REGRAS:\n"
        "1. Use SOMENTE os fatos confirmados abaixo. NÃO acrescente origem, lugar, "
        "número, certificação ou selo que não esteja na lista. Se um fato não está "
        "listado, simplesmente não o mencione.\n"
        "2. Tom humano, caloroso e concreto, valorizando o trabalho do extrativista e "
        "a floresta em pé — mas sem exageros publicitários nem adjetivos vazios. "
        "Transforme os fatos em uma pequena história com começo, meio e fim, não numa "
        "lista de características.\n"
        f"3. Atribua a garantia de origem à cooperativa: {cooperativa}.\n\n"
        f"FATOS CONFIRMADOS:\n{fatos}\n\n"
        "Escreva apenas a narrativa (sem título, sem aspas, sem JSON)."
    )
