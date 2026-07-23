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
  const jget = async (url, opts) => {
    const r = await fetch(url, opts);
    let data = null;
    try { data = await r.json(); } catch { /* corpo vazio/inválido */ }
    if (!r.ok) throw new Error((data && data.erro) || (url + " " + r.status));
    return data;
  };
  const erroHTML = (e) => `<p class="vazio"><span class="emoji">📡</span>Não foi possível carregar.<br>
    <small>${esc(e.message)} — o servidor está no ar?</small></p>`;
  const vazioHTML = (emoji, txt) => `<p class="vazio"><span class="emoji">${emoji}</span>${esc(txt)}</p>`;
  // Skeletons (shimmer) enquanto os dados carregam.
  const skRows = (n = 3) => Array.from({ length: n }).map(() => '<div class="sk sk-row"></div>').join("");
  const skStats = '<div class="stat-grid">' + Array.from({ length: 4 }).map(() => '<div class="sk sk-stat"></div>').join("") + '</div>';

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
    : vazioHTML("🌱", "Nenhum lote registrado ainda. Toque em Registrar para começar.");
  const subtitulo = (t) => `<h2 style="font-size:13px;color:var(--verde-txt);text-transform:uppercase;
    letter-spacing:.06em;margin:18px 2px 10px">${esc(t)}</h2>`;

  // Microinteração: números dos cards de estatística "contam" até o valor real
  // (que já veio da API) em vez de aparecer estático — só apresentação, o dado é real.
  function animarContadores(container) {
    container.querySelectorAll(".stat .n").forEach((el) => {
      const alvo = parseInt(el.textContent, 10);
      if (!Number.isFinite(alvo)) return;
      const t0 = performance.now(), dur = 600;
      const passo = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        el.textContent = Math.round(alvo * (1 - Math.pow(1 - p, 3)));  // ease-out cubic
        if (p < 1) requestAnimationFrame(passo);
        else el.textContent = alvo;
      };
      requestAnimationFrame(passo);
    });
  }

  // Mapa simples (SVG, sem tiles externos — offline-first): plota os pontos reais
  // de GPS capturados nas fotos, normalizados numa caixa. Não é um basemap real,
  // é uma dispersão geográfica honesta dos lotes já registrados.
  function mapaSVG(pontos) {
    if (!pontos.length) return vazioHTML("🗺️", "Nenhuma localização por GPS registrada ainda.");
    const lats = pontos.map((p) => p.lat), lngs = pontos.map((p) => p.lng);
    let minLat = Math.min(...lats), maxLat = Math.max(...lats);
    let minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    if (maxLat - minLat < 0.01) { minLat -= 0.05; maxLat += 0.05; }
    if (maxLng - minLng < 0.01) { minLng -= 0.05; maxLng += 0.05; }
    const W = 300, H = 170, PAD = 20;
    const px = (lng) => PAD + (lng - minLng) / (maxLng - minLng) * (W - 2 * PAD);
    const py = (lat) => H - PAD - (lat - minLat) / (maxLat - minLat) * (H - 2 * PAD);
    const dots = pontos.map((p) =>
      `<circle cx="${px(p.lng).toFixed(1)}" cy="${py(p.lat).toFixed(1)}" r="5.5" fill="var(--verde-600)" stroke="var(--card)" stroke-width="1.5">
        <title>${esc(p.produto)} · ${esc(p.slug)}</title></circle>`).join("");
    return `<div class="card" style="padding:14px">
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;border-radius:10px;background:var(--verde-50)">${dots}</svg>
      <p class="li-s" style="margin-top:8px;text-align:center">📍 ${pontos.length} localização(ões) registrada(s) por GPS — posições aproximadas</p>
    </div>`;
  }

  // ---- PAINEL (Início) ----
  const ctaRegistrar = `<a class="lista-item" href="#registrar"
      style="background:linear-gradient(135deg,var(--verde-600),var(--verde-700));border:0;box-shadow:0 6px 18px rgba(21,104,58,.28);margin-bottom:14px">
      <span class="av" style="background:rgba(255,255,255,.22);color:#fff">📷</span>
      <span class="li-main"><span class="li-t" style="color:#fff">Registrar novo lote</span>
        <span class="li-s" style="color:#e6f5ec">Captura + IA local · funciona offline</span></span>
      <span style="color:#fff;font-size:22px;font-weight:700">›</span></a>`;

  async function painel() {
    const el = q("painelConteudo");
    el.innerHTML = ctaRegistrar + skStats + skRows(3);
    try {
      const [r, lotes, pontos] = await Promise.all([
        jget("/api/resumo"), jget("/api/lotes"), jget("/api/mapa_pontos"),
      ]);
      el.innerHTML = ctaRegistrar + `
        <div class="stat-grid">
          <div class="stat"><div class="n">${r.total_lotes}</div><div class="l">Lotes registrados</div></div>
          <div class="stat"><div class="n">${r.total_produtores}</div><div class="l">Produtores</div></div>
          <div class="stat"><div class="n">${r.produtos_distintos.length}</div><div class="l">Produtos cadastrados</div></div>
          <div class="stat"><div class="n">${r.comunidades_atendidas.length}</div><div class="l">Comunidades atendidas</div></div>
          <div class="stat"><div class="n">${r.lotes_rastreaveis_completos}</div><div class="l">Rastreabilidade completa</div></div>
          <div class="stat"><div class="n">${r.denuncias_abertas}</div><div class="l">Denúncias abertas</div></div>
        </div>
        ${subtitulo("Mapa dos lotes")}
        ${mapaSVG(pontos)}
        ${subtitulo("Últimos lotes")}
        ${listaLotesHTML(lotes.slice(0, 5))}`;
      animarContadores(el);
    } catch (e) { el.innerHTML = erroHTML(e); }
  }

  // ---- LOTES (histórico) ----
  async function lotes() {
    const el = q("lotesConteudo");
    el.innerHTML = skRows(5);
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
      : vazioHTML("🔎", "Nenhum lote encontrado para “" + termo + "”.");
  }

  // ---- PRODUTORES + PERFIL ----
  async function produtores() {
    q("perfilProdutor").classList.add("hide");
    q("produtoresConteudo").classList.remove("hide");
    const el = q("produtoresConteudo");
    el.innerHTML = skRows(4);
    try {
      const lista = await jget("/api/produtores");
      el.innerHTML = lista.length ? `<div class="lista">${lista.map((p) => `
        <li class="clicavel" data-pid="${p.id}">
          ${p.foto ? `<img class="av" src="${esc(p.foto)}" alt="Foto de ${esc(p.nome)}"/>` : `<span class="av">👤</span>`}
          <span class="li-main"><span class="li-t">${esc(p.nome)}</span>
            <span class="li-s">${esc(p.comunidade || "—")} · cód. ${esc(p.codigo)}</span></span>
          <span class="li-tag">📦 ${p.total_lotes}</span></li>`).join("")}</div>`
        : vazioHTML("👤", "Nenhum produtor cadastrado ainda. Cadastre no fluxo de registro.");
      el.querySelectorAll("li[data-pid]").forEach((li) =>
        li.onclick = () => perfilProdutor(li.dataset.pid));
    } catch (e) { el.innerHTML = erroHTML(e); }
  }
  async function perfilProdutor(pid) {
    const el = q("perfilProdutor");
    q("produtoresConteudo").classList.add("hide");
    el.classList.remove("hide");
    el.classList.add("fade-in");
    el.innerHTML = skRows(3);
    try {
      const p = await jget("/api/produtores/" + pid);
      const ind = p.indicadores || {};
      el.innerHTML = `
        <a href="#produtores" data-voltar style="font-size:13px;font-weight:600;color:var(--verde-600);text-decoration:none">← voltar</a>
        <div class="card" style="margin-top:10px">
          <div style="display:flex;gap:14px;align-items:center">
            ${p.foto ? `<img src="${esc(p.foto)}" alt="Foto de ${esc(p.nome)}" style="width:60px;height:60px;border-radius:50%;object-fit:cover;border:1px solid var(--linha)"/>` : `<span class="av" style="width:60px;height:60px;font-size:26px">👤</span>`}
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
        ${listaLotesHTML(p.historico || [])}`;
      el.querySelector("[data-voltar]").onclick = (e) => { e.preventDefault(); produtores(); };
      animarContadores(el);
    } catch (e) { el.innerHTML = erroHTML(e); }
  }

  // ---- COOPERATIVA (perfil agregado) ----
  async function cooperativa() {
    const el = q("cooperativaConteudo");
    el.innerHTML = skStats + skRows(3);
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
      animarContadores(el);
    } catch (e) { el.innerHTML = erroHTML(e); }
  }

  // ---- DENÚNCIAS ----
  async function denuncias() {
    const el = q("denunciasLista");
    el.innerHTML = skRows(2);
    try {
      const lista = await jget("/api/denuncias");
      el.innerHTML = lista.length ? `<div class="lista">${lista.map((d) => `
        <li><span class="av" style="background:var(--laranja-bg);color:var(--laranja)">⚠️</span>
          <span class="li-main"><span class="li-t">${esc(d.mensagem)}</span>
            <span class="li-s">${d.slug ? "lote " + esc(d.slug) + " · " : ""}${fmtData(d.criado_em)} · ${esc(d.status)}</span></span>
        </li>`).join("")}</div>`
        : vazioHTML("✅", "Nenhuma denúncia registrada.");
    } catch (e) { el.innerHTML = erroHTML(e); }
  }
  q("denEnviar").onclick = async () => {
    const mensagem = q("denMsg").value.trim();
    if (!mensagem) return Toast.aviso("Descreva a irregularidade.");
    const btn = q("denEnviar");
    btn.disabled = true; btn.textContent = "Enviando…";
    try {
      await jget("/api/denuncias", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mensagem, slug: q("denSlug").value.trim(), contato: q("denContato").value.trim() }),
      });
      q("denMsg").value = ""; q("denSlug").value = ""; q("denContato").value = "";
      const ok = q("denMsgOk");
      ok.textContent = "Denúncia registrada. Obrigado por ajudar a manter a transparência.";
      ok.classList.remove("hide");
      Toast.sucesso("Denúncia enviada.");
      denuncias();
    } catch (e) { Toast.erro("Não foi possível enviar: " + e.message); }
    finally { btn.disabled = false; btn.textContent = "Enviar denúncia"; }
  };

  // ---- CONFIG ----
  const IA_KEY = "bioamazon.ia_mode";
  function config() {
    q("cfgCoop").value = window.getCooperativa();
    q("cfgIaModo").value = localStorage.getItem(IA_KEY) || "auto";
    q("cfgIaStatus").textContent = "Motor de IA agora: " +
      (window.GemmaWeb ? GemmaWeb.engineLabel : "—");
    q("cfgMsgOk").classList.add("hide");
  }
  q("btnDemo").onclick = () => window.DemoMode?.iniciar();
  q("cfgSalvar").onclick = () => {
    const v = q("cfgCoop").value.trim();
    if (!v) return Toast.aviso("Informe o nome da cooperativa.");
    setCooperativa(v);
    const antes = localStorage.getItem(IA_KEY) || "auto";
    const modo = q("cfgIaModo").value;
    localStorage.setItem(IA_KEY, modo);
    const ok = q("cfgMsgOk");
    ok.textContent = modo !== antes
      ? "Salvo. Recarregue a página para aplicar o novo modo de IA."
      : "Configuração salva neste dispositivo.";
    ok.classList.remove("hide");
    Toast.sucesso("Configuração salva.");
  };

  // ---- Router ----
  const ROTAS = {
    registrar: null, painel, lotes, rastrear, produtores, cooperativa, denuncias, config,
  };
  // rotas que não têm item próprio na bottom nav destacam o item "pai" mais próximo
  const NAV_PAI = { lotes: "rastrear", cooperativa: "produtores", config: "painel" };
  function navegar() {
    const hash = (location.hash.replace("#", "") || "painel");
    const rota = ROTAS.hasOwnProperty(hash) ? hash : "painel";
    document.querySelectorAll(".view").forEach((v) =>
      v.classList.toggle("hide", v.id !== "view-" + rota));
    const destaque = NAV_PAI[rota] || rota;
    document.querySelectorAll(".bottom-nav a").forEach((a) =>
      a.classList.toggle("ativo", a.getAttribute("href") === "#" + destaque));
    window.scrollTo(0, 0);
    if (ROTAS[rota]) ROTAS[rota]();  // carrega os dados da tela
  }
  q("buscaRastreio").addEventListener("input", filtraRastreio);
  window.addEventListener("hashchange", navegar);
  navegar();
})();
