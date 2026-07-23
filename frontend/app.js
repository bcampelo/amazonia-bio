/* BioAmazon IA — PWA offline-first.
   Fluxo: captura (áudio+foto) -> Gemma LOCAL (Ollama/WebGPU) -> confirmação -> IndexedDB -> fila de sync. */

const $ = (id) => document.getElementById(id);
const net = () => {
  const online = navigator.onLine;
  const el = $("net");
  el.textContent = online ? "🟢 online" : "⚫ offline";
  el.className = "chip " + (online ? "on" : "off");
};
window.addEventListener("online", net); window.addEventListener("offline", net); net();

// ---- Barra de progresso global (durante IA) ----
const showProg = () => $("globalProgress").classList.remove("hide");
const hideProg = () => $("globalProgress").classList.add("hide");

// ---- Loading elegante em botões (spinner + texto trocado, sem "sumir" o botão) ----
function setLoading(btn, on, textoCarregando) {
  btn.disabled = on;
  btn.classList.toggle("carregando", on);
  if (on) { btn.dataset.textoOriginal = btn.dataset.textoOriginal || btn.textContent; btn.textContent = textoCarregando; }
  else if (btn.dataset.textoOriginal) btn.textContent = btn.dataset.textoOriginal;
}

// ---- Indicador de progresso (1 capturar · 2 conferir · 3 narrativa · 4 QR) ----
function setStep(n) {
  document.querySelectorAll(".step").forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle("done", s < n);
    el.classList.toggle("active", s === n);
  });
}
setStep(1);

// ---- Inicializa o Gemma ----
GemmaWeb.init(() => {
  const local = GemmaWeb.local, srv = GemmaWeb.mode === "server";
  const cls = (ok) => "chip " + (local ? "on" : srv ? "cloud" : "err");
  const ia = $("bIa");
  ia.textContent = local ? "📴 IA Local" : srv ? "☁️ IA Nuvem" : "⚠️ IA —";
  ia.className = cls();
  const g = $("bGemma");
  g.textContent = "🤖 Gemma " + (local ? "Local" : srv ? "Nuvem" : "—");
  g.className = cls();
});
// Badge do ASR (whisper.cpp) — status REAL vindo do servidor.
fetch("/api/asr_info").then((r) => (r.ok ? r.json() : null)).then((d) => {
  if (!d) return;
  const a = $("bAsr");
  a.textContent = d.local ? "🎤 Whisper Offline" : "🎤 ASR Nuvem";
  a.className = "chip " + (d.local ? "on" : "cloud");
}).catch(() => {});

// ---- IndexedDB (armazenamento local do lote) ----
let db;
const openDB = () => new Promise((res) => {
  const r = indexedDB.open("bioamazon", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("lotes", { keyPath: "id" });
  r.onsuccess = () => { db = r.result; res(); };
});
// putLote SEMPRE resolve/rejeita de verdade (bug corrigido: antes devolvia o
// IDBRequest cru, então todo `await putLote(...)` seguia sem esperar o commit
// e engolia erros de escrita em silêncio).
const putLote = (l) => new Promise((res, rej) => {
  const req = db.transaction("lotes", "readwrite").objectStore("lotes").put(l);
  req.onsuccess = () => res();
  req.onerror = () => rej(req.error);
});
const allLotes = () => new Promise((res) => {
  const out = []; const c = db.transaction("lotes").objectStore("lotes").openCursor();
  c.onsuccess = (e) => { const cur = e.target.result; if (cur){ out.push(cur.value); cur.continue(); } else res(out); };
});

// ---- Escape HTML (usado por vários renders abaixo) ----
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));

// ---- fetch com tratamento de erro padronizado (evita rejections silenciosas) ----
async function jfetch(url, opts) {
  const r = await fetch(url, opts);
  let data = null;
  try { data = await r.json(); } catch { /* corpo vazio/ inválido */ }
  if (!r.ok) throw new Error((data && data.erro) || (url + " -> " + r.status));
  return data;
}

// ============================================================================
// CADEIA DE EVIDÊNCIAS (Fase 2) — cada etapa vira um elo auditável.
// Fotos carregam GPS + horário + fonte (câmera ao vivo = verificada / arquivo =
// não verificada). Áudio, análise do Gemma, confirmação e narrativa carimbam hora.
// ============================================================================
const CADEIA = [
  { key: "produtor",    icon: "👤", titulo: "Foto do produtor" },
  { key: "coleta",      icon: "🌴", titulo: "Foto da coleta" },
  { key: "produto",     icon: "🫐", titulo: "Foto do produto (usada pelo Gemma)" },
  { key: "audio",       icon: "🎙️", titulo: "Relato em áudio do produtor" },
  { key: "gemma",       icon: "🤖", titulo: "Análise do Gemma (ficha)" },
  { key: "confirmacao", icon: "✔️", titulo: "Confirmação do operador" },
  { key: "narrativa",   icon: "📖", titulo: "Narrativa final" },
];
const evidencias = {};   // key -> dado da evidência

const horaBR = (iso) => new Date(iso).toLocaleString("pt-BR",
  { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function gpsMeta(gps) {
  if (!gps) return "";
  return gps.ok
    ? ` · <span class="g">📍 ${gps.lat}, ${gps.lng} (±${gps.accuracy ?? "?"} m)</span>`
    : ` · <span class="ng">⚠️ ${esc(gps.motivo)}</span>`;
}

function metaDaEvidencia(key, ev) {
  if (["produtor", "coleta", "produto"].includes(key)) {
    const fonte = ev.fonte === "camera" ? "📷 câmera ao vivo" : "📎 arquivo (não verificada)";
    return `${fonte} · 🕒 ${horaBR(ev.timestamp)}${gpsMeta(ev.gps)}`;
  }
  if (key === "audio") return `🕒 ${horaBR(ev.timestamp)}${ev.temTranscript ? " · transcrição capturada" : ""}`;
  if (key === "gemma") return `🕒 ${horaBR(ev.timestamp)} · ${ev.preenchidos}/9 campos preenchidos`;
  if (key === "confirmacao") return `🕒 ${horaBR(ev.timestamp)} · fatos revisados por humano` +
    (ev.editados ? ` · ${ev.editados} campo(s) corrigido(s)` : "");
  if (key === "narrativa") return `🕒 ${horaBR(ev.timestamp)} · gerada só com fatos confirmados`;
  return "";
}

function renderCadeia() {
  $("cadeia").innerHTML = CADEIA.map(({ key, icon, titulo }) => {
    const ev = evidencias[key];
    const feito = !!ev;
    return `<li class="${feito ? "feito" : "pendente"}">
      <span class="ci">${feito ? "✓" : icon}</span>
      <span class="cinfo"><span class="ctitulo">${esc(titulo)}</span>
        ${feito ? `<span class="cmeta">${metaDaEvidencia(key, ev)}</span>` : ""}</span>
    </li>`;
  }).join("");
}
function marcarEvidencia(key, dado) { evidencias[key] = dado; renderCadeia(); }
renderCadeia();

// ---- Tiles de captura de foto (produtor / coleta / produto) ----
function renderTile(tipo) {
  const el = $("tile" + tipo.charAt(0).toUpperCase() + tipo.slice(1));
  const ev = evidencias[tipo];
  if (!ev) return;
  const gpsBadge = ev.gps?.ok
    ? `<span class="badge gps">📍 GPS</span>`
    : `<span class="badge nogps">⚠️ sem GPS</span>`;
  const fonteBadge = ev.fonte === "camera"
    ? `<span class="badge cam">📷 ao vivo</span>`
    : `<span class="badge arq">📎 arquivo</span>`;
  el.classList.add("ok");
  el.innerHTML = `<img src="${ev.image}" alt="${esc(tipo)}"/>
    <div class="tbadges">${fonteBadge}${gpsBadge}</div>`;
}

async function capturarTile(tipo, label) {
  const ev = await Evidence.capturePhoto(label);
  if (!ev) return;
  marcarEvidencia(tipo, ev);
  renderTile(tipo);
  const b = $("bGps");
  if (ev.gps?.ok) { b.textContent = "📍 GPS ativo"; b.className = "chip on"; }
  else { b.textContent = "📍 GPS indisponível"; b.className = "chip err"; }
}
$("tileProdutor").onclick = () => capturarTile("produtor", "Foto do produtor");
$("tileColeta").onclick   = () => capturarTile("coleta", "Foto da coleta (produto sendo colhido)");
$("tileProduto").onclick  = () => capturarTile("produto", "Foto principal do produto");

// ============================================================================
// PRODUTOR (Fase 3) — cada lote pertence a um produtor cadastrado. Base do
// histórico de produção sustentável e dos indicadores (ver backend/db.py).
// ============================================================================
let produtorSelecionado = null;

async function carregarProdutores() {
  try {
    const lista = await jfetch("/api/produtores");
    const sel = $("selProdutor");
    sel.querySelectorAll("option[data-pid]").forEach((o) => o.remove());
    const antesDe = sel.querySelector('option[value="novo"]');
    for (const p of lista) {
      const o = document.createElement("option");
      o.value = String(p.id); o.dataset.pid = "1";
      o.textContent = `${p.nome}${p.comunidade ? " — " + p.comunidade : ""} (${p.total_lotes} lote(s))`;
      sel.insertBefore(o, antesDe);
    }
  } catch { /* offline: segue sem lista */ }
}

$("selProdutor").onchange = async (e) => {
  const v = e.target.value;
  $("novoProdutorForm").classList.toggle("hide", v !== "novo");
  if (v === "" || v === "novo") {
    produtorSelecionado = null;
    $("produtorInfo").classList.add("hide");
    return;
  }
  try {
    produtorSelecionado = await jfetch("/api/produtores/" + v);
    renderProdutorInfo(produtorSelecionado);
  } catch (err) { Toast.erro("Não foi possível carregar o produtor: " + err.message); }
};

function renderProdutorInfo(p) {
  const ind = p.indicadores || {};
  $("produtorInfo").classList.remove("hide");
  $("produtorInfo").innerHTML =
    `${p.foto ? `<img src="${p.foto}" alt="Foto de ${esc(p.nome)}"/>` : ""}
     <div><div class="pnome">${esc(p.nome)}</div>
       <div class="pmeta">${esc(p.comunidade || "")}${p.comunidade && p.cooperativa ? " · " : ""}${esc(p.cooperativa || "")} · cód. ${esc(p.codigo)}</div>
       <div class="prod-chips">
         <span class="chip">📦 ${ind.total_lotes || 0} lote(s)</span>
         <span class="chip">🔗 ${ind.lotes_rastreaveis_completos || 0} rastreável(is)</span>
       </div></div>`;
}

$("npSalvar").onclick = async () => {
  const nome = $("npNome").value.trim();
  if (!nome) return Toast.aviso("Informe o nome do produtor.");
  const ev = evidencias.produtor;  // reaproveita foto + GPS já capturados no tile "Produtor"
  const body = { nome, comunidade: $("npComunidade").value.trim(), cooperativa: cooperativaNome() };
  if (ev) { body.foto = ev.image; if (ev.gps?.ok) { body.lat = ev.gps.lat; body.lng = ev.gps.lng; } }
  const btn = $("npSalvar");
  btn.disabled = true; btn.textContent = "Cadastrando…";
  try {
    produtorSelecionado = await jfetch("/api/produtores", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    await carregarProdutores();
    $("selProdutor").value = String(produtorSelecionado.id);
    $("novoProdutorForm").classList.add("hide");
    $("npNome").value = ""; $("npComunidade").value = "";
    renderProdutorInfo(produtorSelecionado);
    Toast.sucesso("Produtor cadastrado.");
  } catch (err) { Toast.erro("Falha ao cadastrar produtor: " + err.message); }
  finally { btn.disabled = false; btn.textContent = "Cadastrar produtor"; }
};

carregarProdutores();

// ---- Captura de áudio + foto ----
// O Gemma (via servidor/Gemini API) só recebe texto+imagem, não áudio. A fala é
// transcrita por ASR (não é raciocínio): 1º a Web Speech API do navegador (nativa,
// ao vivo); se ela não existir ou falhar, cai no /api/transcrever (servidor). O
// TEXTO segue pro Gemma, que faz 100% da extração/narrativa. O áudio gravado fica
// para playback/auditoria.
let media, mediaStream = null, chunks = [], audioBlob = null;
let finalTranscript = "", srError = null;

const $trans = () => $("transcricao");
function showTrans() {
  $("transLabel").style.display = "block";
  $trans().classList.remove("hide");
}
function setStatus(msg, cls) {
  const el = $("transStatus");
  el.className = "hint" + (cls ? " " + cls : "");
  el.innerHTML = (cls === "trabalhando" ? '<span class="dot"></span>' : "") + esc(msg);
  el.classList.toggle("hide", !msg);
}

// ---- Medição da pipeline offline (ASR local + Gemma local) ----
let pipeTimes = { asr: 0, extract: 0, narrate: 0 };
const fmtS = (ms) => (ms / 1000).toFixed(1) + "s";
function renderTempos() {
  const el = $("tempos"); if (!el) return;
  const { asr, extract, narrate } = pipeTimes;
  const total = asr + extract + narrate;
  if (!total) { el.classList.add("hide"); return; }
  const partes = [];
  if (asr) partes.push(`🎙️ ASR ${fmtS(asr)}`);
  if (extract) partes.push(`🤖 Gemma ${fmtS(extract)}`);
  if (narrate) partes.push(`📖 narrativa ${fmtS(narrate)}`);
  el.innerHTML = `⏱️ ${partes.join(" · ")} · <b>total ${fmtS(total)}</b> — 100% no dispositivo`;
  el.classList.remove("hide");
}

// ============================================================================
// PIPELINE VISUAL DA IA (Fase 3) — deixa claro pra banca o que a IA está
// fazendo, passo a passo, com o status mudando ao vivo conforme cada etapa
// realmente acontece (não é decorativo: reflete as chamadas reais abaixo).
// ============================================================================
const PIPELINE_IA = [
  { key: "audio",        icon: "🎤", titulo: "Áudio gravado" },
  { key: "transcricao",  icon: "📝", titulo: "Transcrição offline" },
  { key: "interpretando",icon: "🤖", titulo: "Gemma interpretando o relato" },
  { key: "extraindo",    icon: "📋", titulo: "Extraindo informações" },
  { key: "narrativa",    icon: "📄", titulo: "Gerando narrativa" },
  { key: "concluido",    icon: "✅", titulo: "Registro concluído" },
];
const pipelineEstado = {};  // key -> { status: pendente|ativo|feito|erro, meta }

function renderPipelineIA() {
  $("pipelineCard").classList.remove("hide");
  $("pipelineIA").innerHTML = PIPELINE_IA.map(({ key, icon, titulo }) => {
    const st = pipelineEstado[key] || { status: "pendente" };
    const ic = st.status === "feito" ? "✓" : st.status === "erro" ? "✕" : icon;
    return `<li class="${st.status}">
      <span class="pi">${ic}</span>
      <span class="pinfo"><span class="ptitulo">${esc(titulo)}</span>
        ${st.meta ? `<span class="pmeta">${esc(st.meta)}</span>` : ""}</span>
    </li>`;
  }).join("");
}
function setEtapaIA(key, status, meta) {
  pipelineEstado[key] = { status, meta };
  renderPipelineIA();
}
function resetPipelineIA() {
  for (const k of Object.keys(pipelineEstado)) delete pipelineEstado[k];
  renderPipelineIA();
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = SR ? new SR() : null;
if (recognition) {
  recognition.lang = "pt-BR"; recognition.continuous = true; recognition.interimResults = true;
  recognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalTranscript += t + " ";
      else interim += t;
    }
    showTrans();
    $trans().value = (finalTranscript + interim).trim();
  };
  recognition.onerror = (e) => {
    srError = e.error;
    console.warn("[speech] erro de reconhecimento:", e.error);
  };
}

$("rec").onclick = async () => {
  try {
    if (!media || media.state === "inactive") {
      if (!navigator.mediaDevices?.getUserMedia) {
        return Toast.erro("Microfone indisponível: só funciona em contexto seguro (HTTPS ou " +
          "localhost). Se abriu pelo IP da rede, troque para http://localhost:8000.", { ms: 8000 });
      }
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStream = s;
      media = new MediaRecorder(s); chunks = [];
      finalTranscript = ""; srError = null; audioBlob = null;
      $trans().value = "";
      media.ondataavailable = (e) => chunks.push(e.data);
      media.onstop = onRecordingStopped;
      media.start();
      try { recognition?.start(); } catch { /* sem SR neste navegador */ }
      $("rec").textContent = "■ Parar";
      $("rec").classList.add("gravando");
      setStatus(recognition ? "Ouvindo… fale o relato do produtor" : "Gravando… (transcrição será feita localmente)",
                "trabalhando");
      resetPipelineIA();
      setEtapaIA("audio", "ativo", "gravando…");
    } else {
      // Trava o botão até onRecordingStopped terminar a transcrição — evita
      // iniciar uma 2ª gravação enquanto audioBlob/pipeTimes ainda estão em uso.
      $("rec").disabled = true;
      $("rec").textContent = "Finalizando…";
      $("rec").classList.remove("gravando");
      media.stop();
      try { recognition?.stop(); } catch { /* já parado */ }
    }
  } catch (e) {
    setStatus("Falha ao acessar o microfone: " + e.message, "erro");
    Toast.erro("Falha ao acessar o microfone. Verifique a permissão nas configurações do navegador.",
              { ms: 6500 });
  }
};

// Ao parar: monta o áudio (playback) e decide a fonte da transcrição.
async function onRecordingStopped() {
  // Libera o microfone de verdade (sem isso, o navegador mantém o indicador de
  // gravação ativo e o dispositivo ocupado até a aba fechar — vazamento real).
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;

  audioBlob = new Blob(chunks, { type: "audio/webm" });
  const a = $("aud"); a.src = URL.createObjectURL(audioBlob); a.classList.remove("hide");
  marcarEvidencia("audio", { timestamp: new Date().toISOString(), temTranscript: false });
  showTrans();
  setEtapaIA("audio", "feito");
  setEtapaIA("transcricao", "ativo", "whisper.cpp…");

  // ASR LOCAL-FIRST: o whisper.cpp no servidor local é a fonte autoritativa e roda
  // OFFLINE. A Web Speech (se existiu) serviu só de preview ao vivo. Damos um instante
  // para os últimos resultados do preview e então finalizamos com o whisper local.
  await new Promise((r) => setTimeout(r, 200));
  setStatus("Transcrevendo localmente (whisper.cpp)…", "trabalhando");
  showProg();
  try {
    const res = await GemmaWeb.transcribeViaServer(audioBlob);   // { transcript, engine, ms }
    if (res.transcript) $trans().value = res.transcript;
    pipeTimes = { asr: res.ms || 0, extract: 0, narrate: 0 };
    renderTempos();
    setStatus(`Transcrição: ${esc(res.engine)} · ${fmtS(res.ms)}. Confira/edite se precisar.`,
              res.transcript ? "" : "erro");
    setEtapaIA("transcricao", res.transcript ? "feito" : "erro", `${res.engine} · ${fmtS(res.ms)}`);
  } catch (e) {
    // servidor local fora do ar: usa o que a Web Speech pegou (se algo)
    if ($trans().value.trim()) {
      setStatus("Usando transcrição do navegador (ASR local indisponível: " + e.message + ").", "");
      setEtapaIA("transcricao", "feito", "navegador (fallback)");
    } else {
      setStatus("Sem transcrição — digite a fala abaixo. (" + e.message + ")", "erro");
      setEtapaIA("transcricao", "erro", e.message);
    }
  } finally {
    hideProg();
    $("rec").disabled = false;
    $("rec").textContent = "● Gravar novamente";
  }
  if (evidencias.audio) { evidencias.audio.temTranscript = $trans().value.trim().length > 0; renderCadeia(); }
}

// ---- Passagem 1: Gemma (relato + foto do produto -> ficha JSON) ----
let fichaAtual;
$("proc").onclick = async () => {
  const transcript = $trans().value.trim();
  const fotoProduto = evidencias.produto?.image || null;
  if (!transcript && !fotoProduto) {
    return Toast.aviso("Capture o relato (áudio/texto) ou a foto do PRODUTO antes de processar.");
  }
  setLoading($("proc"), true, "Processando com o Gemma…"); showProg();
  if (!pipelineEstado.audio) $("pipelineCard").classList.remove("hide");  // relato digitado sem gravar
  setEtapaIA("interpretando", "ativo", "reorganizando o relato…");
  try {
    const { ficha, relato, ms } = await GemmaWeb.extract({ transcript, imageSource: fotoProduto, audioBlob });
    fichaAtual = ficha;
    pipeTimes.extract = ms || 0; renderTempos();
    if (relato) { $("relato").value = relato; $("relatoBox").classList.remove("hide"); }
    else $("relatoBox").classList.add("hide");
    setEtapaIA("interpretando", "feito", fmtS(ms || 0));
    setEtapaIA("extraindo", "ativo", "preenchendo a ficha…");
    renderFicha();
    const preenchidos = Object.values(ficha).filter((v) => v.value && v.value !== "não informado").length;
    marcarEvidencia("gemma", { timestamp: new Date().toISOString(), preenchidos,
                               local: GemmaWeb.local, engine: GemmaWeb.engineLabel });
    setEtapaIA("extraindo", "feito", `${preenchidos}/9 campos`);
    $("fichaCard").classList.remove("hide");
    setStep(2);
    $("fichaCard").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    Toast.erro("Falha ao processar: " + e.message);
    setEtapaIA("interpretando", "erro", e.message);
  } finally { hideProg(); setLoading($("proc"), false); }
  $("proc").textContent = "Reprocessar";
};

// Proveniência = o sinal real de confiança que temos (não é um score inventado):
// audio/imagem = observado diretamente (alta confiança); inferido = deduzido pelo
// Gemma (confiança média); confirmado = revisado por humano (máxima confiança).
const CONFIANCA = {
  audio:      { label: "Áudio",      conf: "Alta confiança",   cls: "conf-alta",  icon: "🎙️" },
  imagem:     { label: "Imagem",     conf: "Alta confiança",   cls: "conf-alta",  icon: "📷" },
  inferido:   { label: "Inferido",   conf: "Confiança média",  cls: "conf-media", icon: "🔍" },
  confirmado: { label: "Confirmado", conf: "Revisado por humano", cls: "conf-humana", icon: "✔️" },
};

let fichaOriginal = null;  // snapshot da IA, para detectar edição manual no confirm

function renderFicha() {
  fichaOriginal = JSON.parse(JSON.stringify(fichaAtual));
  const cont = $("ficha"); cont.innerHTML = "";
  for (const [k, v] of Object.entries(fichaAtual)) {
    const vazio = v.value === "não informado";
    const c = CONFIANCA[v.provenance] || CONFIANCA.inferido;
    cont.innerHTML += `<div class="campo ${vazio ? "campo-vazio" : ""}">
      <label>${esc(k.replace(/_/g, " "))}</label>
      <input type="text" data-campo="${k}" value="${esc(v.value)}" ${vazio ? 'placeholder="não informado — edite se souber"' : ""}/>
      <span class="prov ${c.cls}" data-prov-de="${k}">${c.icon} ${c.label} · ${c.conf}</span>
    </div>`;
  }
}

// ---- Confirmação (loop de confiança: operador pode corrigir cada campo) + Passagem 2 ----
$("confirm").onclick = async () => {
  let editados = 0;
  for (const inp of $("ficha").querySelectorAll("input[data-campo]")) {
    const k = inp.dataset.campo;
    if (fichaOriginal?.[k] && inp.value !== fichaOriginal[k].value) editados++;
    fichaAtual[k].value = inp.value;
    fichaAtual[k].provenance = "confirmado";
  }
  for (const span of $("ficha").querySelectorAll("[data-prov-de]")) {
    const k = span.dataset.provDe;
    const foiEditado = fichaOriginal?.[k] && fichaAtual[k].value !== fichaOriginal[k].value;
    span.textContent = foiEditado ? "✏️ Confirmado (editado)" : "✔️ Confirmado";
    span.className = "prov conf-humana" + (foiEditado ? " conf-editado" : "");
  }
  if (editados) Toast.info(`${editados} campo(s) corrigido(s) manualmente antes de confirmar.`);
  marcarEvidencia("confirmacao", { timestamp: new Date().toISOString(), editados });
  $("narr").textContent = "Gerando jornada…";
  $("narrCard").classList.remove("hide");
  setStep(3);
  showProg();
  setLoading($("confirm"), true, "Gerando narrativa…");
  setEtapaIA("narrativa", "ativo", "escrevendo a jornada…");
  try {
    const { narrativa, ms } = await GemmaWeb.narrate(fichaAtual, cooperativaNome());
    $("narr").textContent = narrativa;
    pipeTimes.narrate = ms || 0; renderTempos();
    setEtapaIA("narrativa", "feito", fmtS(ms || 0));
    setEtapaIA("concluido", "feito", "pronto para salvar");
    marcarEvidencia("narrativa", { timestamp: new Date().toISOString(),
                                   local: GemmaWeb.local, engine: GemmaWeb.engineLabel });
  } catch (e) {
    $("narr").textContent = "Falha ao gerar narrativa: " + e.message;
    setEtapaIA("narrativa", "erro", e.message);
    Toast.erro("Falha ao gerar narrativa: " + e.message);
  } finally { hideProg(); setLoading($("confirm"), false); }
};
// A cooperativa é configurável (tela Config, localStorage) — definida em screens.js
// (window.getCooperativa), que carrega depois deste arquivo. O fallback só entra
// em uso caso screens.js algum dia deixe de ser carregado.
const COOP_PADRAO = "Cooperativa Exemplo (Resex Chico Mendes)";
const cooperativaNome = () => (window.getCooperativa ? window.getCooperativa() : COOP_PADRAO);

$("salvar").onclick = async () => {
  const btn = $("salvar");
  btn.disabled = true; btn.textContent = "Salvando…";
  try {
    const id = "lote_" + Date.now();
    await putLote({ id, ficha: fichaAtual, narrativa: $("narr").textContent,
                    relato: $("relato").value.trim(),
                    produtor_id: produtorSelecionado?.id || null,
                    evidencias: JSON.parse(JSON.stringify(evidencias)),
                    status: "rascunho_local", criado_em: new Date().toISOString() });
    await refreshFila();
    Toast.sucesso("Lote salvo localmente. Publicaremos ao sincronizar.",
      navigator.onLine ? { acaoLabel: "Sincronizar agora", onAcao: () => sincronizar(true) } : {});
  } catch (err) {
    Toast.erro("Não foi possível salvar localmente: " + err.message);
  } finally { btn.disabled = false; btn.textContent = "Salvar lote (local, offline)"; }
};

async function refreshFila() {
  const ls = (await allLotes()).filter(l => l.status === "rascunho_local");
  $("fila").textContent = ls.length ? `${ls.length} lote(s) pendente(s) de publicação`
                                     : "nenhum lote pendente";
}

$("sync").onclick = () => sincronizar(true);

// Auto-sync ao reconectar: fila local -> publica sozinho quando a internet volta
// (offline-first: capturei/guardei offline, sincronizo "sozinho" depois).
window.addEventListener("online", () => sincronizar(false));

async function sincronizar(manual) {
  if (!navigator.onLine) {
    if (manual) Toast.aviso("Sem internet — os lotes ficam salvos e sincronizam sozinhos ao reconectar.");
    return;
  }
  const ls = (await allLotes()).filter(l => l.status === "rascunho_local");
  if (!ls.length) { if (manual) Toast.info("Nenhum lote pendente."); return; }
  const syncBtn = $("sync");
  syncBtn.disabled = true; syncBtn.textContent = "Sincronizando…"; showProg();
  let ultimo = null, falhas = 0;
  for (const l of ls) {
    try {
      const info = await jfetch("/api/publicar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ficha_confirmada: l.ficha, narrativa: l.narrativa,
                               cooperativa: cooperativaNome(), evidencias: l.evidencias || {},
                               relato: l.relato || "", produtor_id: l.produtor_id || null }),
      });
      l.status = "publicado"; l.slug = info.slug; l.url = info.url;
      await putLote(l);
      ultimo = info;
    } catch (err) {
      falhas++;
      console.warn("[sync] falha ao publicar lote", l.id, err.message);
    }
  }
  hideProg();
  syncBtn.disabled = false; syncBtn.textContent = "Sincronizar e publicar";
  await refreshFila();
  if (ultimo) {
    $("qrImg").src = "data:image/png;base64," + ultimo.qr_base64;
    $("linkPublico").href = ultimo.url; $("linkPublico").textContent = ultimo.url;
    $("publicadoCard").classList.remove("hide");
    setStep(4);
  }
  const ok = ls.length - falhas;
  if (falhas) {
    if (manual) Toast.erro(`${ok} lote(s) publicado(s). ${falhas} falharam — continuam na fila.`);
  } else if (ok) {
    // o toast aparece também no auto-sync: o usuário merece saber que algo
    // aconteceu sozinho quando a conexão voltou, mesmo sem ter clicado em nada.
    Toast.sucesso(manual ? `${ok} lote(s) publicado(s).` : `Conexão restabelecida: ${ok} lote(s) publicado(s) automaticamente.`);
  }
}

openDB().then(refreshFila);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
