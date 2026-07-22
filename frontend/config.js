/* Configuração do runtime Gemma no navegador (WebGPU via MediaPipe tasks-genai).
   Ajuste MODEL_URL para onde você hospedar o modelo convertido para web. */
window.BIOAMAZON_CONFIG = {
  // Modelo Gemma convertido para WEB (.litertlm com "-Web" no nome).
  // Baixe de litert-community no Hugging Face e sirva junto do app (pasta models/).
  // Para aparelho mais fraco, troque por um E2B ou Gemma3-1B/270M -Web.
  MODEL_URL: "./models/gemma-3n-E2B-it-int4-Web.litertlm",

  // Runtime MediaPipe (ESM + wasm) via CDN — cacheado pelo Service Worker após 1ª carga.
  TASKS_GENAI_ESM: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@latest",
  WASM_BASE: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@latest/wasm",

  MAX_TOKENS: 1024,
  TOP_K: 40,
  TEMPERATURE: 0.3,     // MediaPipe Web fixa a temperatura na criação do engine
  MAX_IMAGES: 1,
  SUPPORT_AUDIO: true,  // Gemma 3n faz ASR on-device (áudio .wav mono)
  AUDIO_SR: 16000       // taxa alvo para o WAV enviado ao Gemma
};
