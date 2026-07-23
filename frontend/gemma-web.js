/* gemma-web.js — ÚNICO ponto de contato com o Gemma no navegador.
   Espelha backend/gemma/gemma_generate.py: mesmos prompts, mesmo schema.
   Ordem de preferência, cada uma REAL (nenhuma inventa dado):
     1. "server"  — Gemma real via server/app.py (/api/extrair, /api/narrar), o caminho
        padrão sempre que o servidor Flask está no ar.
     2. "webgpu"  — Gemma rodando on-device via MediaPipe tasks-genai (precisa de um
        arquivo .litertlm em frontend/models/, que este repo não inclui — fica dormente
        até alguém fornecer um modelo real).
   Não existe mais modo mock: se nenhum dos dois acima estiver disponível, extract()/
   narrate() lançam erro explícito. Regra do projeto: nenhuma resposta simulada. */
(() => {
  const C = window.BIOAMAZON_CONFIG;
  const FICHA_FIELDS = ["produto","variedade","origem","metodo_coleta_manejo",
    "epoca_safra","caracteristicas_sensoriais","praticas_sustentaveis","volume","unidade"];

  let llm = null, mode = null;

  // ---------------- Prompts (idênticos ao backend Python, usados só no modo webgpu) ----------------
  const EXTRACTION_SYS =
    "Você é o motor de extração do BioAmazon IA. A partir da FALA de um produtor " +
    "extrativista (áudio, em português) e de uma FOTO do produto, extraia fatos objetivos " +
    "e devolva APENAS um JSON válido, sem texto fora do JSON. REGRAS: 1) NUNCA invente " +
    "origem, comunidade, certificação, selo ou número; se não foi dito nem é visível use " +
    "\"não informado\". 2) Marque a PROVENIÊNCIA de cada campo: \"audio\", \"imagem\" ou " +
    "\"inferido\". 3) Só fatos, nada de narrativa.";
  const EXTRACTION_TAIL =
    "\nDevolva um JSON com EXATAMENTE estes campos, cada um como " +
    '{"value":"...","provenance":"audio|imagem|inferido"}: ' + FICHA_FIELDS.join(", ") + ".";

  const narrPrompt = (ficha, coop) => {
    const fatos = Object.entries(ficha)
      .filter(([,v]) => v && v.value && v.value !== "não informado")
      .map(([k,v]) => `  - ${k}: ${v.value} (fonte: ${v.provenance})`).join("\n");
    return "Você é o motor narrativo do BioAmazon IA. Escreva, em português, uma jornada " +
      "curta (3 a 5 frases) que valorize este produto para um comprador. Use SOMENTE os " +
      "fatos confirmados abaixo; não acrescente origem, número ou certificação fora da lista. " +
      "Tom respeitoso e concreto. Atribua a garantia de origem à cooperativa: " + coop +
      ".\n\nFATOS CONFIRMADOS:\n" + fatos + "\n\nEscreva apenas a narrativa.";
  };

  // ---------------- Inicialização (ARQUITETURA LOCAL-FIRST / Edge AI) ----------------
  // Ordem: ON-DEVICE (WebGPU) PRIMEIRO -> nuvem (servidor) como FALLBACK. O modo
  // local é o objetivo; o remoto só entra quando o on-device não está disponível
  // (sem modelo, sem WebGPU) ou quando o operador força "nuvem" nas Configurações.
  let serverBackend = null;

  function iaPref() {
    try { return localStorage.getItem("bioamazon.ia_mode") || "auto"; } catch { return "auto"; }
  }

  // O modelo on-device é grande e baixado à parte. Perguntamos ao servidor se ele
  // existe (endpoint limpo) em vez de "sondar" o arquivo no navegador — isso evita
  // um 404 no console. O resultado é cacheado para funcionar offline depois.
  async function modeloDisponivel() {
    try {
      const r = await fetch("/api/modelo_local");
      if (r.ok) {
        const d = await r.json();
        try { localStorage.setItem("bioamazon.modelo_local", d.disponivel ? "1" : "0"); } catch { /* */ }
        return !!d.disponivel;
      }
    } catch { /* offline: usa o último resultado conhecido */ }
    try { return localStorage.getItem("bioamazon.modelo_local") === "1"; } catch { return false; }
  }

  async function initOnDevice() {
    if (!("gpu" in navigator)) throw new Error("WebGPU indisponível neste navegador");
    if (!(await modeloDisponivel()))
      throw new Error("modelo on-device ausente (" + C.MODEL_URL + ") — ver frontend/models/README.txt");
    // runtime local (offline); se o vendor sumir, cai no CDN.
    let esm = C.TASKS_GENAI_ESM, wasm = C.WASM_BASE;
    let mod;
    try { mod = await import(esm); }
    catch { esm = C.TASKS_GENAI_ESM_CDN; wasm = C.WASM_BASE_CDN; mod = await import(esm); }
    const { FilesetResolver, LlmInference } = mod;
    const genai = await FilesetResolver.forGenAiTasks(wasm);
    llm = await LlmInference.createFromOptions(genai, {
      baseOptions: { modelAssetPath: C.MODEL_URL },
      maxTokens: C.MAX_TOKENS, topK: C.TOP_K, temperature: C.TEMPERATURE,
      maxNumImages: C.MAX_IMAGES, supportAudio: C.SUPPORT_AUDIO,
    });
    mode = "webgpu";
  }

  async function initServidor() {
    const r = await fetch("/api/health");
    if (!r.ok) throw new Error("servidor respondeu " + r.status);
    serverBackend = (await r.json()).backend;
    mode = "server";
  }

  async function init(onStatus) {
    const pref = iaPref();
    if (pref !== "nuvem") {              // LOCAL-FIRST: tenta on-device
      try { onStatus?.("procurando IA no dispositivo…"); await initOnDevice();
            onStatus?.(engineLabel()); return mode; }
      catch (e) { console.warn("[gemma-web] on-device indisponível:", e.message); }
    }
    if (pref !== "local") {              // fallback: nuvem
      try { onStatus?.("conectando à IA na nuvem (fallback)…"); await initServidor();
            onStatus?.(engineLabel()); return mode; }
      catch (e) { console.warn("[gemma-web] nuvem indisponível:", e.message); }
    }
    mode = "indisponivel"; onStatus?.(engineLabel()); return mode;
  }

  // Ollama roda na MÁQUINA do operador (edge) — é inferência LOCAL, não nuvem.
  // Só o backend "gemini" é remoto/nuvem.
  function servidorEhLocal() { return mode === "server" && serverBackend && serverBackend !== "gemini"; }

  function engineLabel() {
    if (mode === "webgpu") return "no dispositivo (WebGPU, offline)";
    if (servidorEhLocal()) return "no dispositivo (" + serverBackend + ", local)";
    if (mode === "server") return "nuvem — fallback (" + (serverBackend || "gemini") + ")";
    return iaPref() === "local"
      ? "indisponível (modo local forçado, sem modelo on-device)"
      : "indisponível";
  }

  // ---------------- Passagem 1: EXTRAÇÃO (relato+imagem -> {ficha, relato}) ----------------
  // Retorno padronizado: { ficha, relato } — 'relato' é a fala reorganizada pelo
  // Gemma (só no modo server hoje; vazio no webgpu).
  async function extract({ transcript, imageSource, audioBlob }) {
    if (mode === "server") return await serverExtract(transcript, imageSource);
    if (mode === "webgpu") {
      const parts = [EXTRACTION_SYS];
      if (audioSource_ok(audioBlob)) {
        const wavUrl = URL.createObjectURL(await toWavMono(audioBlob, C.AUDIO_SR));
        parts.push("\nFALA DO PRODUTOR (áudio):", { audioSource: wavUrl });
      } else if (transcript) {
        parts.push("\nFALA DO PRODUTOR (transcrição):\n<<<" + transcript + ">>>");
      }
      if (imageSource) parts.push("\nFOTO DO PRODUTO:", { imageSource });
      parts.push(EXTRACTION_TAIL);
      const raw = await llm.generateResponse(parts);
      return { ficha: parseFicha(raw), relato: transcript || "", ms: 0 };
    }
    throw new Error("Gemma indisponível. Inicie o servidor (python3 server/app.py na raiz do projeto) e recarregue a página.");
  }

  // ---------------- Fallback de ASR no servidor (só transcrição) ----------------
  // Usado quando a Web Speech API do navegador não existe/falha. Converte o áudio
  // gravado (webm/opus) em WAV mono — a Gemini API de ASR não aceita webm cru — e
  // manda pro /api/transcrever. NÃO é o Gemma: é só transcrição (ver backend/asr).
  async function transcribeViaServer(audioBlob) {
    // Funciona em qualquer modo desde que haja rede (é ASR, não o Gemma). No modo
    // on-device offline não há servidor: a transcrição fica com a Web Speech API.
    const wav = await toWavMono(audioBlob, C.AUDIO_SR);
    const audio_base64 = await blobToBase64(wav);
    const r = await fetch("/api/transcrever", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio_base64 }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.erro || ("Falha na transcrição (" + r.status + ")"));
    return data;  // { transcript, engine, ms }
  }

  // ---------------- Passagem 2: NARRATIVA ----------------
  async function narrate(ficha, coop) {   // -> { narrativa, ms }
    if (mode === "server") {
      const r = await fetch("/api/narrar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ficha_confirmada: ficha, cooperativa: coop }),
      });
      if (!r.ok) throw new Error("Falha no servidor (" + r.status + ")");
      const data = await r.json();
      return { narrativa: data.narrativa, ms: data.ms || 0 };
    }
    if (mode === "webgpu") return { narrativa: await llm.generateResponse(narrPrompt(ficha, coop)), ms: 0 };
    throw new Error("Gemma indisponível. Inicie o servidor (python3 server/app.py na raiz do projeto) e recarregue a página.");
  }

  // ---------------- Backend "server": Gemma real mediado por HTTP ----------------
  // O Gemma hospedado via Gemini API não aceita áudio (só texto+imagem), então
  // o navegador manda a TRANSCRIÇÃO (Web Speech API, em app.js) como texto —
  // quem extrai e narra continua sendo sempre o Gemma, no servidor.
  async function serverExtract(transcript, imageSource) {
    const body = { transcript: transcript || "" };
    if (imageSource) body.image_base64 = await blobUrlToBase64(imageSource);
    const r = await fetch("/api/extrair", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("Falha no servidor (" + r.status + ")");
    const data = await r.json();
    // /api/extrair devolve { ficha, relato, ms }.
    return { ficha: data.ficha || data, relato: data.relato || "", ms: data.ms || 0 };
  }

  async function blobUrlToBase64(url) {
    return await blobToBase64(await (await fetch(url)).blob());
  }
  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  // ---------------- Utilidades (só usadas no modo webgpu) ----------------
  function audioSource_ok(b) { return !!b && !!C.SUPPORT_AUDIO; }

  function parseFicha(raw) {
    let obj;
    try { obj = JSON.parse(raw); }
    catch { const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
            obj = s >= 0 ? JSON.parse(raw.slice(s, e + 1)) : {}; }
    const out = {};
    for (const f of FICHA_FIELDS) {
      const c = obj[f];
      out[f] = (c && typeof c === "object" && "value" in c)
        ? { value: c.value, provenance: c.provenance || "inferido" }
        : { value: "não informado", provenance: "inferido" };
    }
    return out;
  }

  // Converte áudio gravado (webm/opus) em WAV mono PCM16 na taxa alvo (Gemma exige wav mono).
  async function toWavMono(blob, targetSr) {
    const buf = await blob.arrayBuffer();
    const ac = new (window.OfflineAudioContext || window.AudioContext)(1, 1, targetSr);
    const decoded = await ac.decodeAudioData(buf);
    const src = decoded.getChannelData(0);
    const ratio = decoded.sampleRate / targetSr;
    const n = Math.floor(src.length / ratio);
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, src[Math.floor(i * ratio)]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return encodeWav(pcm, targetSr);
  }
  function encodeWav(pcm, sr) {
    const b = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(b);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i], true);
    return new Blob([b], { type: "audio/wav" });
  }

  window.GemmaWeb = {
    init, extract, narrate, transcribeViaServer,
    get mode() { return mode; },
    get local() { return mode === "webgpu" || servidorEhLocal(); },  // inferência local (edge)?
    get engineLabel() { return engineLabel(); },
  };
})();
