MODELO GEMMA ON-DEVICE (WebGPU) — coloque o arquivo aqui.

A arquitetura é LOCAL-FIRST: com um modelo aqui, o app roda o Gemma NO DISPOSITIVO
(offline, badge "📴 IA: no dispositivo"). Sem ele, cai automaticamente para a nuvem.

Como instalar (uma vez, com internet):
  bash scripts/baixar_modelo.sh <URL_DIRETA_DO_MODELO>

O arquivo deve casar com MODEL_URL em ../config.js:
  gemma-3n-E2B-it-int4-Web.litertlm   (multimodal texto+IMAGEM, ~2,6 GB)

Onde baixar (coleção oficial "litert-community"/"google" na Hugging Face; aceite a licença):
  - Multimodal (texto+imagem): Gemma 3n E2B  (~2,6 GB) ou E4B (~3,7 GB)
  - So texto, mais leve:        Gemma 3 1B / Gemma 3 270M  (roda em mais aparelhos)
  Guia: https://ai.google.dev/edge/mediapipe/solutions/genai/llm_inference/web_js

Observacoes:
  - O RUNTIME (MediaPipe/LiteRT wasm) ja esta vendorizado em ../vendor/tasks-genai
    (offline, sem CDN). So o MODELO fica de fora por ser grande e licenciado.
  - Audio on-device NAO e suportado no navegador — a transcricao continua por ASR
    (Web Speech / servidor). Audio-nativo on-device so na casca Android (LiteRT-LM).
  - Requer Chrome/Edge com WebGPU e aparelho com RAM suficiente para o modelo.
