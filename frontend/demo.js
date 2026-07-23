/* demo.js — Modo Demonstração: um GUIA passo a passo para a apresentação ao
   vivo, não uma simulação. Nenhum dado é fabricado e nenhum clique é
   automatizado: o app destaca visualmente o que fazer a seguir e detecta
   sozinho quando o apresentador realmente completou aquele passo (gravou o
   áudio de verdade, tirou a foto de verdade, o Gemma terminou de processar
   etc.), lendo o mesmo estado que o resto do app já mantém (evidencias,
   pipelineEstado, fichaAtual — variáveis globais de app.js, que não usa IIFE).
   Carrega por último, depois de app.js/screens.js. */
(() => {
  const PASSOS = [
    {
      titulo: "Grave um relato",
      texto: "Toque em “Gravar a fala do produtor” e fale sobre a coleta.",
      alvo: "#rec",
      pronto: () => typeof evidencias !== "undefined" && !!evidencias.audio,
    },
    {
      titulo: "Tire as fotos",
      texto: "Capture ao menos a foto do Produto (produtor e coleta reforçam a rastreabilidade).",
      alvo: "#tileProduto",
      pronto: () => typeof evidencias !== "undefined" && !!evidencias.produto,
    },
    {
      titulo: "IA processando",
      texto: "Toque em “Processar com o Gemma” — a IA local transcreve, interpreta e extrai a ficha.",
      alvo: "#proc",
      pronto: () => document.querySelectorAll("#ficha input[data-campo]").length >= 9,
    },
    {
      titulo: "Campos preenchidos",
      texto: "Confira os campos extraídos pela IA e toque em “Confirmar e gerar jornada”.",
      alvo: "#confirm",
      pronto: () => {
        const n = document.getElementById("narr")?.textContent.trim();
        return !!n && n !== "Gerando jornada…" && !n.startsWith("Falha");
      },
    },
    {
      titulo: "Narrativa criada",
      texto: "O Gemma escreveu a jornada usando só os fatos confirmados. Toque em “Salvar lote”.",
      alvo: "#salvar",
      pronto: () => typeof pipeTimes !== "undefined" && pipeTimes.narrate > 0 &&
                    !document.getElementById("narrCard").classList.contains("hide"),
      // avança já no passo seguinte assim que o lote estiver salvo (fila > 0) ou publicado
      avancarSe: () => !document.getElementById("fila").textContent.startsWith("nenhum") ||
                       !document.getElementById("publicadoCard").classList.contains("hide"),
    },
    {
      titulo: "Página pública pronta",
      texto: "Toque em “Sincronizar e publicar” para gerar a página pública do lote.",
      alvo: "#sync",
      pronto: () => !document.getElementById("publicadoCard").classList.contains("hide"),
    },
    {
      titulo: "QR Code gerado",
      texto: "O QR Code da página pública deste lote já está na tela, logo abaixo.",
      alvo: "#qrImg",
      pronto: () => true,  // é só uma pausa informativa; avança ao tocar em "Próximo"
      manual: true,
    },
    {
      titulo: "Escaneie este QR",
      texto: "Peça para alguém escanear com o celular — a página pública abre na hora, com toda a rastreabilidade.",
      alvo: "#qrImg",
      manual: true,
      ultimo: true,
    },
  ];

  let passoAtual = -1;
  let poller = null;
  let alvoAtual = null;

  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function montarBanner() {
    const b = el(`
      <div class="demo-banner" role="region" aria-label="Modo demonstração">
        <div class="demo-topo">
          <span class="demo-tag">🎬 MODO DEMONSTRAÇÃO</span>
          <button type="button" class="demo-fechar" aria-label="Encerrar demonstração">✕</button>
        </div>
        <div class="demo-corpo">
          <span class="demo-passo-n"></span>
          <div>
            <div class="demo-titulo"></div>
            <div class="demo-texto"></div>
          </div>
        </div>
        <div class="demo-dots"></div>
        <button type="button" class="demo-proximo hide">Próximo →</button>
      </div>`);
    document.body.appendChild(b);
    b.querySelector(".demo-fechar").onclick = encerrar;
    b.querySelector(".demo-proximo").onclick = () => avancar();
    return b;
  }

  function destacar(seletor) {
    limparDestaque();
    const alvo = document.querySelector(seletor);
    if (!alvo) return;
    alvo.classList.add("demo-destaque");
    alvoAtual = alvo;
    alvo.scrollIntoView({ behavior: "smooth", block: "center" });
    // O banner tem pointer-events:none (ver CSS) precisamente para isto: mesmo
    // que o alvo fique perto/atrás dele após o scroll, o toque real passa
    // direto para o botão — só os controles do próprio banner ficam clicáveis.
  }
  function limparDestaque() {
    alvoAtual?.classList.remove("demo-destaque");
    alvoAtual = null;
  }

  function renderPasso() {
    const p = PASSOS[passoAtual];
    const banner = document.querySelector(".demo-banner");
    if (!banner || !p) return;
    banner.querySelector(".demo-passo-n").textContent = (passoAtual + 1) + "/" + PASSOS.length;
    banner.querySelector(".demo-titulo").textContent = p.titulo;
    banner.querySelector(".demo-texto").textContent = p.texto;
    banner.querySelector(".demo-dots").innerHTML = PASSOS.map((_, i) =>
      `<span class="dd ${i < passoAtual ? "feito" : i === passoAtual ? "atual" : ""}"></span>`).join("");
    const btnProx = banner.querySelector(".demo-proximo");
    btnProx.classList.toggle("hide", !p.manual);
    btnProx.textContent = p.ultimo ? "Encerrar demonstração" : "Próximo →";
    if (location.hash !== "#registrar") location.hash = "#registrar";
    destacar(p.alvo);
  }

  function iniciarPolling() {
    clearInterval(poller);
    poller = setInterval(() => {
      const p = PASSOS[passoAtual];
      if (!p || p.manual) return;
      try {
        if (p.pronto() && (!p.avancarSe || p.avancarSe())) avancar();
      } catch { /* elemento ainda não existe na tela — tenta de novo no próximo tick */ }
    }, 450);
  }

  function avancar() {
    const p = PASSOS[passoAtual];
    if (p?.ultimo) return encerrar();
    passoAtual++;
    if (passoAtual >= PASSOS.length) return encerrar();
    renderPasso();
  }

  function iniciar() {
    if (document.querySelector(".demo-banner")) return;  // já em andamento
    montarBanner();
    passoAtual = 0;
    renderPasso();
    iniciarPolling();
    Toast.info("Demonstração iniciada — siga as instruções na parte de baixo da tela.");
  }

  function encerrar() {
    clearInterval(poller);
    limparDestaque();
    document.querySelector(".demo-banner")?.remove();
  }

  window.DemoMode = { iniciar, encerrar };
})();
