/* toast.js — notificações não-bloqueantes (substituem os alert()/confirm() que
   travavam a interface). Carrega ANTES de app.js/screens.js para window.Toast
   já existir quando os outros scripts rodam.
   Uso: Toast.show("mensagem", "sucesso"|"erro"|"info"|"aviso", { ms, acaoLabel, onAcao }) */
(() => {
  let host;
  function ensureHost() {
    if (host) return host;
    host = document.createElement("div");
    host.className = "toast-host";
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
    return host;
  }

  const ICONES = { sucesso: "✅", erro: "⚠️", info: "ℹ️", aviso: "⏳" };

  function show(msg, tipo = "info", opts = {}) {
    const h = ensureHost();
    const el = document.createElement("div");
    el.className = "toast toast-" + tipo;
    el.setAttribute("role", tipo === "erro" ? "alert" : "status");
    const acaoHTML = opts.acaoLabel
      ? `<button type="button" class="toast-acao">${opts.acaoLabel}</button>` : "";
    el.innerHTML = `<span class="toast-ic">${ICONES[tipo] || ""}</span>
      <span class="toast-msg"></span>${acaoHTML}
      <button type="button" class="toast-x" aria-label="Fechar">✕</button>`;
    el.querySelector(".toast-msg").textContent = msg;  // textContent: evita HTML injection
    h.appendChild(el);
    requestAnimationFrame(() => el.classList.add("in"));

    let timer;
    const fechar = () => {
      clearTimeout(timer);
      el.classList.remove("in");
      el.addEventListener("transitionend", () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 400);  // rede de segurança se transitionend não disparar
    };
    el.querySelector(".toast-x").onclick = fechar;
    if (opts.acaoLabel) el.querySelector(".toast-acao").onclick = () => { opts.onAcao?.(); fechar(); };
    timer = setTimeout(fechar, opts.ms || (tipo === "erro" ? 6000 : 3600));
    return fechar;
  }

  window.Toast = {
    show,
    sucesso: (m, o) => show(m, "sucesso", o),
    erro: (m, o) => show(m, "erro", o),
    info: (m, o) => show(m, "info", o),
    aviso: (m, o) => show(m, "aviso", o),
  };
})();

/* ---- Ripple: microinteração de toque em botões/cards/tiles clicáveis ----
   Delegado no document (não precisa marcar cada elemento) — funciona em
   qualquer botão, item de lista ou tile, inclusive os que screens.js gera
   dinamicamente depois. Puramente visual, não interfere no onclick real. */
(() => {
  const ALVO = "button, a.lista-item, li.clicavel, .tile";
  document.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(ALVO);
    if (!el || el.disabled) return;
    el.classList.add("ripple-wrap");
    const r = el.getBoundingClientRect();
    const d = Math.max(r.width, r.height);
    const span = document.createElement("span");
    span.className = "ripple";
    span.style.width = span.style.height = d + "px";
    span.style.left = (e.clientX - r.left - d / 2) + "px";
    span.style.top = (e.clientY - r.top - d / 2) + "px";
    el.appendChild(span);
    span.addEventListener("animationend", () => span.remove());
  });
})();
