/* Configuração do runtime Gemma ON-DEVICE no navegador (WebGPU).

   ARQUITETURA LOCAL-FIRST (Edge AI): o app tenta rodar o Gemma NO DISPOSITIVO
   primeiro (aqui) e só cai para a nuvem (servidor/Gemini) como fallback — ver
   frontend/gemma-web.js::init(). Este arquivo diz ONDE está o runtime e o modelo.

   Runtime VENDORIZADO localmente (frontend/vendor/tasks-genai) → o caminho
   on-device NÃO depende de CDN nem de internet. Só falta o arquivo do MODELO
   (grande, baixado uma vez) em frontend/models/ para ativar a inferência local. */
window.BIOAMAZON_CONFIG = {
  // Modelo Gemma para WEB (.litertlm/.task). Baixe uma vez da coleção
  // "litert-community" (Hugging Face) e salve em frontend/models/. Ver
  // scripts/baixar_modelo.sh e frontend/models/README.txt.
  // Multimodal (texto+IMAGEM) exige Gemma 3n E2B/E4B (~2,6-3,7 GB). Modelos
  // pequenos (Gemma 3 1B/270M) são só texto.
  MODEL_URL: "./models/gemma-3n-E2B-it-int4-Web.litertlm",

  // Runtime MediaPipe/LiteRT (ESM + wasm) — SERVIDO LOCALMENTE (offline-first).
  TASKS_GENAI_ESM: "./vendor/tasks-genai/genai_bundle.mjs",
  WASM_BASE: "./vendor/tasks-genai/wasm",
  // Fallback via CDN (só se o vendor local sumir; exige internet):
  TASKS_GENAI_ESM_CDN: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.29",
  WASM_BASE_CDN: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.29/wasm",

  MAX_TOKENS: 1024,
  TOP_K: 40,
  TEMPERATURE: 0.3,     // MediaPipe Web fixa a temperatura na criação do engine
  MAX_IMAGES: 1,
  SUPPORT_AUDIO: false, // áudio on-device NÃO é suportado no navegador (só Android/LiteRT-LM).
  AUDIO_SR: 16000       // taxa alvo do WAV (usado no fallback de ASR do servidor)
};
