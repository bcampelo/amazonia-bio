#!/usr/bin/env bash
# Baixa um modelo Gemma para inferência ON-DEVICE no navegador (WebGPU) e o coloca
# em frontend/models/. Roda UMA vez, com internet; depois o app roda offline.
#
# Por que não vem no repo: o modelo é grande (Gemma 3n E2B multimodal ~2,6 GB) e é
# distribuído sob licença (aceite na Hugging Face / Kaggle). Baixe você mesmo.
#
# Uso:
#   bash scripts/baixar_modelo.sh <URL_DIRETA_DO_MODELO>
# ou defina MODEL_URL no ambiente. O nome do arquivo salvo deve BATER com
# MODEL_URL em frontend/config.js (padrão: gemma-3n-E2B-it-int4-Web.litertlm).
#
# Onde achar (coleção oficial "litert-community" / "google" na Hugging Face):
#   - Multimodal (texto+IMAGEM, ~2,6 GB):   Gemma 3n E2B  (.litertlm/.task "-Web")
#   - Maior (texto+imagem, ~3,7 GB):        Gemma 3n E4B
#   - Só texto, leve (roda em mais aparelhos): Gemma 3 1B / Gemma 3 270M
#   Guia oficial: https://ai.google.dev/edge/mediapipe/solutions/genai/llm_inference/web_js
set -euo pipefail
DEST_DIR="$(cd "$(dirname "$0")/.." && pwd)/frontend/models"
DEST_FILE="$DEST_DIR/gemma-3n-E2B-it-int4-Web.litertlm"
URL="${1:-${MODEL_URL:-}}"

if [ -z "$URL" ]; then
  echo "Informe a URL direta do modelo:"
  echo "  bash scripts/baixar_modelo.sh <URL>"
  echo "(aceite a licença na Hugging Face/Kaggle e copie o link do arquivo .litertlm/.task)"
  exit 1
fi

mkdir -p "$DEST_DIR"
echo "Baixando modelo on-device para $DEST_FILE ..."
curl -L --fail -o "$DEST_FILE" "$URL"
echo "OK. Ajuste MODEL_URL em frontend/config.js se o nome do arquivo for diferente."
echo "Recarregue o app: ele passará a usar a IA NO DISPOSITIVO (badge 📴)."
