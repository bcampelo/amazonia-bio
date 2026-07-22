/* BioAmazon IA — PWA offline-first.
   Fluxo: captura (áudio+foto) -> Gemma LOCAL (WebGPU) -> confirmação -> IndexedDB -> fila de sync.
   Inferência real via GemmaWeb (MediaPipe tasks-genai / WebGPU); degrada para mock. */

const $ = (id) => document.getElementById(id);
const net = () => {
  const online = navigator.onLine;
  $("net").textContent = online ? "online" : "offline";
  $("net").classList.toggle("ok", online);
};
window.addEventListener("online", net); window.addEventListener("offline", net); net();

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
GemmaWeb.init((s) => {
  const el = $("gemma");
  el.textContent = "Gemma: " + s;
  el.classList.toggle("erro", GemmaWeb.mode === "indisponivel");
  el.classList.toggle("ok", GemmaWeb.mode === "server" || GemmaWeb.mode === "webgpu");
});

// ---- IndexedDB (armazenamento local do lote) ----
let db;
const openDB = () => new Promise((res) => {
  const r = indexedDB.open("bioamazon", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("lotes", { keyPath: "id" });
  r.onsuccess = () => { db = r.result; res(); };
});
const putLote = (l) => db.transaction("lotes", "readwrite").objectStore("lotes").put(l);
const allLotes = () => new Promise((res) => {
  const out = []; const c = db.transaction("lotes").objectStore("lotes").openCursor();
  c.onsuccess = (e) => { const cur = e.target.result; if (cur){ out.push(cur.value); cur.continue(); } else res(out); };
});

// ---- Escape HTML (usado por vários renders abaixo) ----
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));

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
  if (key === "confirmacao") return `🕒 ${horaBR(ev.timestamp)} · fatos revisados por humano`;
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
    const r = await fetch("/api/produtores");
    if (!r.ok) return;
    const lista = await r.json();
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
  const r = await fetch("/api/produtores/" + v);
  if (r.ok) { produtorSelecionado = await r.json(); renderProdutorInfo(produtorSelecionado); }
};

function renderProdutorInfo(p) {
  const ind = p.indicadores || {};
  $("produtorInfo").classList.remove("hide");
  $("produtorInfo").innerHTML =
    `${p.foto ? `<img src="${p.foto}" alt="produtor"/>` : ""}
     <div><div class="pnome">${esc(p.nome)}</div>
       <div class="pmeta">${esc(p.comunidade || "")}${p.comunidade && p.cooperativa ? " · " : ""}${esc(p.cooperativa || "")} · cód. ${esc(p.codigo)}</div>
       <div class="prod-chips">
         <span class="chip">📦 ${ind.total_lotes || 0} lote(s)</span>
         <span class="chip">🔗 ${ind.lotes_rastreaveis_completos || 0} rastreável(is)</span>
       </div></div>`;
}

$("npSalvar").onclick = async () => {
  const nome = $("npNome").value.trim();
  if (!nome) return alert("Informe o nome do produtor.");
  const ev = evidencias.produtor;  // reaproveita foto + GPS já capturados no tile "Produtor"
  const body = { nome, comunidade: $("npComunidade").value.trim(), cooperativa: cooperativaNome() };
  if (ev) { body.foto = ev.image; if (ev.gps?.ok) { body.lat = ev.gps.lat; body.lng = ev.gps.lng; } }
  const r = await fetch("/api/produtores", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) return alert("Falha ao cadastrar produtor.");
  produtorSelecionado = await r.json();
  await carregarProdutores();
  $("selProdutor").value = String(produtorSelecionado.id);
  $("novoProdutorForm").classList.add("hide");
  $("npNome").value = ""; $("npComunidade").value = "";
  renderProdutorInfo(produtorSelecionado);
};

carregarProdutores();

// ---- Captura de áudio + foto ----
// O Gemma (via servidor/Gemini API) só recebe texto+imagem, não áudio. A fala é
// transcrita por ASR (não é raciocínio): 1º a Web Speech API do navegador (nativa,
// ao vivo); se ela não existir ou falhar, cai no /api/transcrever (servidor). O
// TEXTO segue pro Gemma, que faz 100% da extração/narrativa. O áudio gravado fica
// para playback/auditoria.
let media, chunks = [], audioBlob = null;
let finalTranscript = "", srError = null, srActive = false;

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
        return alert("Microfone indisponível: o navegador só libera captura de áudio em " +
          "contexto seguro (HTTPS ou localhost). Se você abriu pelo IP da rede " +
          "(ex.: http://192.168.x.x:8000), troque para http://localhost:8000.");
      }
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      media = new MediaRecorder(s); chunks = [];
      finalTranscript = ""; srError = null; audioBlob = null;
      $trans().value = "";
      media.ondataavailable = (e) => chunks.push(e.data);
      media.onstop = onRecordingStopped;
      media.start(); srActive = false;
      try { recognition?.start(); srActive = !!recognition; } catch { srActive = false; }
      $("rec").textContent = "■ Parar";
      $("rec").classList.add("gravando");
      setStatus(recognition ? "Ouvindo… fale o relato do produtor" : "Gravando… (transcrição será feita no servidor)",
                "trabalhando");
    } else {
      media.stop(); try { recognition?.stop(); } catch { /* já parado */ }
      $("rec").textContent = "● Gravar novamente";
      $("rec").classList.remove("gravando");
    }
  } catch (e) {
    setStatus("Falha ao acessar o microfone: " + e.message, "erro");
    alert("Falha ao acessar o microfone: " + e.message +
      " (verifique se a permissão foi concedida nas configurações do navegador/site).");
  }
};

// Ao parar: monta o áudio (playback) e decide a fonte da transcrição.
async function onRecordingStopped() {
  audioBlob = new Blob(chunks, { type: "audio/webm" });
  const a = $("aud"); a.src = URL.createObjectURL(audioBlob); a.classList.remove("hide");
  marcarEvidencia("audio", { timestamp: new Date().toISOString(), temTranscript: false });

  // dá um instante pro SR entregar os últimos resultados finais
  await new Promise((r) => setTimeout(r, 350));
  const jaTem = $trans().value.trim().length > 0;

  // Fallback no servidor quando o navegador não transcreveu (sem SR, erro, ou vazio).
  if (!jaTem && (!recognition || srError || !finalTranscript.trim())) {
    if (GemmaWeb.mode !== "server") {
      setStatus("Sem transcrição do navegador e servidor indisponível — digite a fala abaixo.", "erro");
      showTrans(); return;
    }
    showTrans();
    setStatus("Transcrevendo no servidor…", "trabalhando");
    try {
      const t = await GemmaWeb.transcribeViaServer(audioBlob);
      $trans().value = t;
      setStatus(t ? "Transcrição pronta (servidor). Confira e edite se precisar."
                  : "Não foi possível entender a fala — digite manualmente.", t ? "" : "erro");
    } catch (e) {
      setStatus("Falha na transcrição do servidor: " + e.message + " — digite a fala abaixo.", "erro");
    }
  } else {
    showTrans();
    setStatus("Transcrição pronta (navegador). Confira e edite se precisar.", "");
  }
  if (evidencias.audio) { evidencias.audio.temTranscript = $trans().value.trim().length > 0; renderCadeia(); }
}

// ---- Passagem 1: Gemma (relato + foto do produto -> ficha JSON) ----
let fichaAtual;
$("proc").onclick = async () => {
  const transcript = $trans().value.trim();
  const fotoProduto = evidencias.produto?.image || null;
  if (!transcript && !fotoProduto) {
    return alert("Capture o relato (áudio/texto) ou a foto do PRODUTO antes de processar.");
  }
  $("proc").disabled = true; $("proc").textContent = "Processando com o Gemma…";
  try {
    const { ficha, relato } = await GemmaWeb.extract({ transcript, imageSource: fotoProduto, audioBlob });
    fichaAtual = ficha;
    if (relato) { $("relato").value = relato; $("relatoBox").classList.remove("hide"); }
    else $("relatoBox").classList.add("hide");
    renderFicha();
    const preenchidos = Object.values(ficha).filter((v) => v.value && v.value !== "não informado").length;
    marcarEvidencia("gemma", { timestamp: new Date().toISOString(), preenchidos });
    $("fichaCard").classList.remove("hide");
    setStep(2);
    $("fichaCard").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { alert("Falha ao processar: " + e.message); }
  $("proc").disabled = false; $("proc").textContent = "Reprocessar";
};

function renderFicha() {
  const cont = $("ficha"); cont.innerHTML = "";
  for (const [k, v] of Object.entries(fichaAtual)) {
    cont.innerHTML += `<div class="campo">
      <label>${k.replace(/_/g, " ")}</label>
      <input type="text" data-campo="${k}" value="${esc(v.value)}"/>
      <span class="prov ${v.provenance}" data-prov-de="${k}">${v.provenance}</span>
    </div>`;
  }
}

// ---- Confirmação (loop de confiança: operador pode corrigir cada campo) + Passagem 2 ----
$("confirm").onclick = async () => {
  for (const inp of $("ficha").querySelectorAll("input[data-campo]")) {
    const k = inp.dataset.campo;
    fichaAtual[k].value = inp.value;
    fichaAtual[k].provenance = "confirmado";
  }
  for (const span of $("ficha").querySelectorAll("[data-prov-de]")) {
    span.textContent = "confirmado"; span.className = "prov confirmado";
  }
  marcarEvidencia("confirmacao", { timestamp: new Date().toISOString() });
  $("narr").textContent = "Gerando jornada…";
  $("narrCard").classList.remove("hide");
  setStep(3);
  $("narr").textContent = await GemmaWeb.narrate(fichaAtual, cooperativaNome());
  marcarEvidencia("narrativa", { timestamp: new Date().toISOString() });
};
// A cooperativa é configurável (tela Config, salva em localStorage). Enquanto
// screens.js não expõe getCooperativa, cai no padrão. Ver window.getCooperativa.
const COOP_PADRAO = "Cooperativa Exemplo (Resex Chico Mendes)";
const cooperativaNome = () => (window.getCooperativa ? window.getCooperativa() : COOP_PADRAO);

$("salvar").onclick = async () => {
  const id = "lote_" + Date.now();
  await putLote({ id, ficha: fichaAtual, narrativa: $("narr").textContent,
                  relato: $("relato").value.trim(),
                  produtor_id: produtorSelecionado?.id || null,
                  evidencias: JSON.parse(JSON.stringify(evidencias)),
                  status: "rascunho_local", criado_em: new Date().toISOString() });
  await refreshFila();
  alert("Lote salvo localmente (com a cadeia de evidências). Publicaremos ao sincronizar.");
};

async function refreshFila() {
  const ls = (await allLotes()).filter(l => l.status === "rascunho_local");
  $("fila").textContent = ls.length ? `${ls.length} lote(s) pendente(s) de publicação`
                                     : "nenhum lote pendente";
}

$("sync").onclick = async () => {
  if (!navigator.onLine) return alert("Sem internet — os lotes ficam salvos e sincronizam depois.");
  const ls = (await allLotes()).filter(l => l.status === "rascunho_local");
  let ultimo = null;
  for (const l of ls) {
    const r = await fetch("/api/publicar", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ficha_confirmada: l.ficha, narrativa: l.narrativa,
                             cooperativa: cooperativaNome(), evidencias: l.evidencias || {},
                             relato: l.relato || "", produtor_id: l.produtor_id || null }),
    });
    if (!r.ok) { alert("Falha ao publicar lote " + l.id); continue; }
    const info = await r.json();
    l.status = "publicado"; l.slug = info.slug; l.url = info.url;
    await putLote(l);
    ultimo = info;
  }
  await refreshFila();
  if (ultimo) {
    $("qrImg").src = "data:image/png;base64," + ultimo.qr_base64;
    $("linkPublico").href = ultimo.url; $("linkPublico").textContent = ultimo.url;
    $("publicadoCard").classList.remove("hide");
    setStep(4);
  }
  alert(`${ls.length} lote(s) publicado(s).`);
};

openDB().then(refreshFila);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
