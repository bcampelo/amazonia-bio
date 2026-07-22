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

// ---- Captura de áudio + foto ----
// O Gemma (via servidor/Gemini API) só recebe texto+imagem, não áudio — então
// transcrevemos a fala com a Web Speech API do navegador (nativa, sem outra IA)
// e mandamos o TEXTO pro Gemma; o áudio gravado fica só para playback/auditoria.
let media, chunks = [], audioBlob = null, fotoURL = null, transcript = "";
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = SR ? new SR() : null;
if (recognition) {
  recognition.lang = "pt-BR"; recognition.continuous = true; recognition.interimResults = false;
  recognition.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) transcript += e.results[i][0].transcript + " ";
    }
  };
  recognition.onerror = (e) => console.warn("[speech] erro de reconhecimento:", e.error);
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
      media = new MediaRecorder(s); chunks = []; transcript = "";
      media.ondataavailable = (e) => chunks.push(e.data);
      media.onstop = () => { audioBlob = new Blob(chunks, { type: "audio/webm" });
        const a = $("aud"); a.src = URL.createObjectURL(audioBlob); a.classList.remove("hide"); };
      media.start(); recognition?.start();
      $("rec").textContent = "■ Parar"; $("rec").classList.add("gravando");
    } else {
      media.stop(); recognition?.stop();
      $("rec").textContent = "● Gravar a fala do produtor"; $("rec").classList.remove("gravando");
    }
  } catch (e) {
    alert("Falha ao acessar o microfone: " + e.message +
      " (verifique se a permissão foi concedida nas configurações do navegador/site).");
  }
};
$("foto").onchange = (e) => { const f = e.target.files[0]; if (!f) return;
  fotoURL = URL.createObjectURL(f); const p = $("prev"); p.src = fotoURL; p.classList.remove("hide"); };

// ---- Passagem 1: Gemma no dispositivo (áudio+imagem -> ficha JSON) ----
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let fichaAtual;
$("proc").onclick = async () => {
  $("proc").disabled = true; $("proc").textContent = "Processando no dispositivo…";
  try {
    fichaAtual = await GemmaWeb.extract({ transcript, imageSource: fotoURL, audioBlob });
    renderFicha();
    $("fichaCard").classList.remove("hide");
    setStep(2);
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
  $("narr").textContent = "Gerando jornada…";
  $("narrCard").classList.remove("hide");
  setStep(3);
  $("narr").textContent = await GemmaWeb.narrate(fichaAtual, cooperativaNome());
};
const cooperativaNome = () => "Cooperativa Exemplo (Resex Chico Mendes)";

$("salvar").onclick = async () => {
  const id = "lote_" + Date.now();
  await putLote({ id, ficha: fichaAtual, narrativa: $("narr").textContent,
                  status: "rascunho_local", criado_em: new Date().toISOString() });
  await refreshFila();
  alert("Lote salvo localmente. Publicaremos ao sincronizar.");
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
      body: JSON.stringify({ ficha_confirmada: l.ficha, narrativa: l.narrativa, cooperativa: cooperativaNome() }),
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
