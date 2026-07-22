/* screens.js — navegação (SPA por hash) + telas de consulta (Fase 4).
   Tudo lê a API REAL (nada de mock): /api/resumo, /api/lotes, /api/produtores,
   /api/denuncias. A tela "Registrar" é o fluxo original (app.js); estas telas são
   de consulta/gestão em torno da rastreabilidade. Carrega DEPOIS de app.js. */
(() => {
  const q = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
  const fmtData = (iso) => {
    if (!iso) return "";
    const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
    return isNaN(d) ? iso : d.toLocaleDateString("pt-BR",
      { day: "2-digit", month: "2-digit", year: "numeric" });
  };
  const jget = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(url + " " + r.status); return r.json(); };
  const erroHTML = (e) => `<p class="vazio">Não foi possível carregar. ${esc(e.message)}<br>
    <small>O servidor está no ar? (python3 server/app.py)</small></p>`;

  // ---- Cooperativa configurável (compartilhada com app.js via window) ----
  const COOP_KEY = "bioamazon.coop";
  const COOP_PADRAO = "Cooperativa Exemplo (Resex Chico Mendes)";
  window.getCooperativa = () => localStorage.getItem(COOP_KEY) || COOP_PADRAO;
  const setCooperativa = (v) => localStorage.setItem(COOP_KEY, v);

  // ---- Componentes reutilizáveis ----
  function loteItemHTML(l) {
    const completa = l.evidencias_completas >= 6;
    const tag = completa
      ? `<span class="li-tag">✓ rastreável</span>`
      : `<span class="li-tag parcial">${l.evidencias_completas}/6 evid.</span>`;
    const prod = l.produtor_nome ? " · 👤 " + esc(l.produtor_nome) : "";
    return `<a class="lista-item" href="${esc(l.url)}" target="_blank" rel="noopener">
      <span class="av">🫐</span>
      <span class="li-main"><span class="li-t">${esc(l.produto)}</span>
        <span class="li-s">${esc(l.cooperativa)}${prod} · ${fmtData(l.criado_em)}</span></span>
      ${tag}</a>`;
  }
  const listaLotesHTML = (lotes) => lotes.length
    ? `<div class="lista">${lotes.map(loteItemHTML).join("")}</div>`
    : `<p class="vazio">Nenhum lote registrado ainda.</p>`;
  const subtitulo = (t) => `<h2 style="font-size:13px;color:var(--verde-600);text-transform:uppercase;
    letter-spacing:.06em;margin:18px 2px 10px">${esc(t)}</h2>`;

  // ---- PAINEL ----
  async function painel() {
    const el = q("painelConteudo");
    try {
      const [r, lotes] = await Promise.all([jget("/api/resumo"), jget("/api/lotes")]);
      el.innerHTML = `
        <div class="stat-grid">
          <div class="stat"><div class="n">${r.total_lotes}</div><div class="l">Lotes registrados</div></div>
          <div class="stat"><div class="n">${r.total_produtores}</div><div class="l">Produtores</div></div>
          <div class="stat"><div class="n">${r.lotes_rastreaveis_completos}</div><div class="l">Rastreabilidade completa</div></div>
          <div class="stat"><div class="n">${r.denuncias_abertas}</div><div class="l">Denúncias abertas</div></div>
        </div>
        ${subtitulo("Últimos lotes")}
        ${listaLotesHTML(lotes.slice(0, 6))}`;
    } catch (e) { el.innerHTML = erroHTML(e); }
  }

  // ---- LOTES (histórico) ----
  async function lotes() {
    const el = q("lotesConteudo");
    try { el.innerHTML = listaLotesHTML(await jget("/api/lotes")); }
    catch (e) { el.innerHTML = erroHTML(e); }
  }

  // ---- RASTREAR (busca) ----
  let _lotesCache = [];
  async function rastrear() {
    const cont = q("rastrearConteudo");
    try { _lotesCache = await jget("/api/lotes"); }
    catch (e) { cont.innerHTML = erroHTML(e); return; }
    filtraRastreio();
  }
  function filtraRastreio() {
    const termo = q("buscaRastreio").value.trim().toLowerCase();
    const res = !termo ? _lotesCache : _lotesCache.filter((l) =>
      [l.produto, l.produtor_nome, l.slug, l.cooperativa].filter(Boolean)
        .some((c) => c.toLowerCase().includes(termo)));
    q("rastrearConteudo").innerHTML = res.length
      ? listaLotesHTML(res)
      : `<p class="vazio">Nenhum lote encontrado para “${esc(termo)}”.</p>`;
  }

  // ---- PRODUTORES + PERFIL ----
  async function produtores() {
    q("perfilProdutor").classList.add("hide");
    q("produtoresConteudo").classList.remove("hide");
    const el = q("produtoresConteudo");
    try {
      const lista = await jget("/api/produtores");
      el.innerHTML = lista.length ? `<div class="lista">${lista.map((p) => `
        <li class="clicavel" data-pid="${p.id}">
          ${p.foto ? `<img class="av" src="${esc(p.foto)}"/>` : `<span class="av">👤</span>`}
          <span class="li-main"><span class="li-t">${esc(p.nome)}</span>
            <span class="li-s">${esc(p.comunidade || "—")} · cód. ${esc(p.codigo)}</span></span>
          <span class="li-tag">📦 ${p.total_lotes}</span></li>`).join("")}</div>`
        : `<p class="vazio">Nenhum produtor cadastrado. Cadastre no fluxo de registro.</p>`;
      el.querySelectorAll("li[data-pid]").forEach((li) =>
        li.onclick = () => perfilProdutor(li.dataset.pid));
    } catch (e) { el.innerHTML = erroHTML(e); }
  }
  async function perfilProdutor(pid) {
    const el = q("perfilProdutor");
    q("produtoresConteudo").classList.add("hide");
    el.classList.remove("hide");
    el.innerHTML = `<p class="vazio">Carregando…</p>`;
    try {
      const p = await jget("/api/produtores/" + pid);
      const ind = p.indicadores || {};
      el.innerHTML = `
        <a href="#produtores" data-voltar style="font-size:13px;font-weight:600;color:var(--verde-600);text-decoration:none">← voltar</a>
        <div class="card" style="margin-top:10px">
          <div style="display:flex;gap:14px;align-items:center">
            ${p.foto ? `<img src="${esc(p.foto)}" style="width:60px;height:60px;border-radius:50%;object-fit:cover;border:1px solid var(--linha)"/>` : `<span class="av" style="width:60px;height:60px;font-size:26px">👤</span>`}
            <div><div style="font-weight:700;font-size:17px">${esc(p.nome)}</div>
              <div class="li-s">${esc(p.comunidade || "—")}${p.comunidade && p.cooperativa ? " · " : ""}${esc(p.cooperativa || "")}</div>
              <div class="li-s">cód. ${esc(p.codigo)} · desde ${fmtData(p.criado_em)}</div></div>
          </div>
        </div>
        ${subtitulo("Indicadores de sustentabilidade")}
        <div class="stat-grid">
          <div class="stat"><div class="n">${ind.total_lotes || 0}</div><div class="l">Lotes registrados</div></div>
          <div class="stat"><div class="n">${ind.lotes_rastreaveis_completos || 0}</div><div class="l">Com rastreabilidade completa</div></div>
        </div>
        <p class="view-sub" style="margin-top:0">Base preparada para reconhecimento de boas práticas
          (regularidade, projetos sustentáveis, selos) — a evoluir.</p>
        ${subtitulo("Histórico de lotes")}
        ${listaLotesHTML((p.historico || []).map(histToResumo))}`;
      el.querySelector("[data-voltar]").onclick = (e) => { e.preventDefault(); produtores(); };
    } catch (e) { el.innerHTML = erroHTML(e); }
  }
  // adapta o formato de buscar_lote (histórico) para o de listaLotesHTML
  function histToResumo(l) {
    const ev = l.evidencias || {};
    const ess = ["produtor", "coleta", "produto", "gemma", "confirmacao", "narrativa"];
    return {
      produto: l.produto, cooperativa: l.cooperativa, produtor_nome: null,
      criado_em: l.criado_em, url: "/p/" + l.slug,
      evidencias_completas: ess.filter((k) => k in ev).length,
    };
  }

  // ---- COOPERATIVA (perfil agregado) ----
  async function cooperativa() {
    const el = q("cooperativaConteudo");
    try {
      const [lotes, prods] = await Promise.all([jget("/api/lotes"), jget("/api/produtores")]);
      const coop = window.getCooperativa();
      const daCoop = lotes.filter((l) => l.cooperativa === coop);
      const prodsCoop = prods.filter((p) => (p.cooperativa || "") === coop);
      el.innerHTML = `
        <div class="card">
          <div style="display:flex;gap:14px;align-items:center">
            <span class="av" style="width:56px;height:56px;font-size:26px">🏭</span>
            <div><div style="font-weight:700;font-size:17px">${esc(coop)}</div>
              <div class="li-s">Perfil da cooperativa neste dispositivo</div></div>
          </div>
        </div>
        <div class="stat-grid">
          <div class="stat"><div class="n">${daCoop.length}</div><div class="l">Lotes da cooperativa</div></div>
          <div class="stat"><div class="n">${prodsCoop.length}</div><div class="l">Produtores vinculados</div></div>
        </div>
        ${subtitulo("Lotes da cooperativa")}
        ${listaLotesHTML(daCoop)}`;
    } catch (e) { el.innerHTML = erroHTML(e); }
  }

  // ---- DENÚNCIAS ----
  async function denuncias() {
    const el = q("denunciasLista");
    try {
      const lista = await jget("/api/denuncias");
      el.innerHTML = lista.length ? `<div class="lista">${lista.map((d) => `
        <li><span class="av">⚠️</span>
          <span class="li-main"><span class="li-t">${esc(d.mensagem)}</span>
            <span class="li-s">${d.slug ? "lote " + esc(d.slug) + " · " : ""}${fmtData(d.criado_em)} · ${esc(d.status)}</span></span>
        </li>`).join("")}</div>`
        : `<p class="vazio">Nenhuma denúncia registrada.</p>`;
    } catch (e) { el.innerHTML = erroHTML(e); }
  }
  q("denEnviar").onclick = async () => {
    const mensagem = q("denMsg").value.trim();
    if (!mensagem) return alert("Descreva a irregularidade.");
    try {
      const r = await fetch("/api/denuncias", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mensagem, slug: q("denSlug").value.trim(), contato: q("denContato").value.trim() }),
      });
      if (!r.ok) throw new Error("falha " + r.status);
      q("denMsg").value = ""; q("denSlug").value = ""; q("denContato").value = "";
      const ok = q("denMsgOk"); ok.textContent = "Denúncia registrada. Obrigado por ajudar a manter a transparência."; ok.classList.remove("hide");
      denuncias();
    } catch (e) { alert("Não foi possível enviar: " + e.message); }
  };

  // ---- CONFIG ----
  function config() {
    q("cfgCoop").value = window.getCooperativa();
    q("cfgMsgOk").classList.add("hide");
  }
  q("cfgSalvar").onclick = () => {
    const v = q("cfgCoop").value.trim();
    if (!v) return alert("Informe o nome da cooperativa.");
    setCooperativa(v);
    const ok = q("cfgMsgOk"); ok.textContent = "Configuração salva neste dispositivo."; ok.classList.remove("hide");
  };

  // ---- Router ----
  const ROTAS = {
    registrar: null, painel, lotes, rastrear, produtores, cooperativa, denuncias, config,
  };
  function navegar() {
    const hash = (location.hash.replace("#", "") || "registrar");
    const rota = ROTAS.hasOwnProperty(hash) ? hash : "registrar";
    document.querySelectorAll(".view").forEach((v) =>
      v.classList.toggle("hide", v.id !== "view-" + rota));
    document.querySelectorAll("nav.tabs a").forEach((a) =>
      a.classList.toggle("ativo", a.getAttribute("href") === "#" + rota));
    window.scrollTo(0, 0);
    if (ROTAS[rota]) ROTAS[rota]();  // carrega os dados da tela
  }
  q("buscaRastreio").addEventListener("input", filtraRastreio);
  window.addEventListener("hashchange", navegar);
  navegar();
})();
