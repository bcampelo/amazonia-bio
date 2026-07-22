#!/usr/bin/env python3
"""
PoC de linha de comando — prova o pipeline do Gemma ponta a ponta.

Uso:
  # Sem rede, sem pesos (prova o FLUXO + schema + proveniência):
  GEMMA_BACKEND=mock python3 cli/run_poc.py --text-file seed/transcript_acai.txt

  # Com Gemma REAL rodando localmente (edge/offline):
  #   1) instale o Ollama e rode:  ollama run gemma3n:e2b
  #   2) GEMMA_BACKEND=ollama python3 cli/run_poc.py --text-file seed/transcript_acai.txt --image foto.jpg

Etapas validadas (a pedido do plano incremental):
  1) roda o Gemma  2) faz inferência  3) devolve JSON  4) gera narrativa.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend.pipeline import extract, confirm, narrate  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="BioAmazon IA — PoC do pipeline Gemma")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--text", help="transcrição da fala do produtor")
    g.add_argument("--text-file", help="arquivo com a transcrição")
    ap.add_argument("--image", help="foto do produto (opcional)")
    ap.add_argument("--cooperativa", default="Cooperativa Exemplo (Resex Chico Mendes)")
    ap.add_argument("--backend", default=os.environ.get("GEMMA_BACKEND", "mock"),
                    choices=["mock", "gemini", "ollama"])
    ap.add_argument("--out", help="salvar registro local (simula o armazenamento offline)")
    args = ap.parse_args()

    transcript = args.text or open(args.text_file, encoding="utf-8").read().strip()

    print(f"\n=== BACKEND: {args.backend} ===")
    print("\n[1/3] PASSAGEM 1 — EXTRAÇÃO (áudio+imagem -> ficha JSON)")
    ficha = extract(transcript, image=args.image, backend=args.backend)
    print(json.dumps(ficha, ensure_ascii=False, indent=2))

    print("\n[2/3] CONFIRMAÇÃO DO OPERADOR (loop de confiança)")
    confirmada = confirm(ficha)  # auto-confirma tudo nesta PoC
    print("  -> todos os campos marcados como 'confirmado'.")

    print("\n[3/3] PASSAGEM 2 — NARRATIVA (só fatos confirmados)")
    narrativa = narrate(confirmada, args.cooperativa, backend=args.backend)
    print(narrativa)

    registro = {"ficha_confirmada": confirmada, "narrativa": narrativa,
                "cooperativa": args.cooperativa, "status": "rascunho_local"}
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(registro, f, ensure_ascii=False, indent=2)
        print(f"\n[offline] registro salvo localmente em {args.out} "
              "(sincroniza/publica quando houver internet).")
    print("\n=== FIM DA POC ===\n")


if __name__ == "__main__":
    main()
