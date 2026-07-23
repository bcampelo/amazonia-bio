"""
Servidor HTTP mínimo do BioAmazon IA.

Duas responsabilidades:
1. Servir o front-end estático (frontend/) — junta tudo num único processo/origem,
   evitando CORS entre a PWA e a API.
2. Mediar o Gemma para o navegador: o Gemma hospedado via Gemini API não aceita
   áudio (só texto+imagem — ver backend/gemma/gemma_generate.py::_gemini), então
   o navegador transcreve a fala (Web Speech API) e manda TEXTO pra cá; quem
   pensa (extração e narrativa) continua sendo sempre o Gemma.

Publicação de página pública + QR: ver rotas /api/publicar e /p/<slug>.
"""
from __future__ import annotations
import base64
import io
import os
import re
import sys
import tempfile
import unicodedata
import uuid
from typing import Optional

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT_DIR)

import qrcode  # noqa: E402
from flask import Flask, abort, jsonify, request, render_template_string, send_from_directory  # noqa: E402

import time  # noqa: E402

from backend import db  # noqa: E402
from backend.pipeline import extract, estruturar_relato, narrate  # noqa: E402
from backend.asr.transcribe import transcribe  # noqa: E402

FRONTEND_DIR = os.path.join(ROOT_DIR, "frontend")
db.init_db()

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")


@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/api/health")
def health():
    from backend.gemma.gemma_generate import DEFAULT_BACKEND
    return jsonify({"status": "ok", "backend": DEFAULT_BACKEND})


@app.get("/api/asr_info")
def asr_info():
    """Status REAL do ASR: whisper.cpp local disponível? (para o badge da UI)."""
    from backend.asr.transcribe import whisper_disponivel
    local = whisper_disponivel()
    return jsonify({"local": local,
                    "engine": "whisper.cpp" if local else "gemini (nuvem)"})


@app.get("/api/modelo_local")
def modelo_local():
    """Informa se há um modelo Gemma on-device instalado em frontend/models/.
    O front usa isto para decidir usar WebGPU (local) — evita 'sondar' o arquivo
    grande no navegador (que polui o console com 404 quando ausente)."""
    models_dir = os.path.join(FRONTEND_DIR, "models")
    exts = (".litertlm", ".task", ".bin")
    arquivos = ([f for f in os.listdir(models_dir) if f.endswith(exts)]
                if os.path.isdir(models_dir) else [])
    return jsonify({"disponivel": bool(arquivos), "arquivos": arquivos})


def _save_temp(raw: bytes, suffix: str) -> str:
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(raw)
    return path


@app.post("/api/transcrever")
def api_transcrever():
    """Fallback de ASR no SERVIDOR (só transcrição, não raciocínio — ver
    backend/asr/transcribe.py). O navegador chama aqui quando a Web Speech API
    não existe/falha, enviando o áudio já convertido para WAV mono. O TEXTO
    volta e segue o fluxo normal; quem extrai/narra continua sendo o Gemma."""
    data = request.get_json(force=True) or {}
    audio_b64 = data.get("audio_base64")
    if not audio_b64:
        return jsonify({"erro": "audio_base64 ausente"}), 400
    audio_path = _save_temp(base64.b64decode(audio_b64), ".wav")
    try:
        resultado = transcribe(audio_path)  # {transcript, engine, ms} — local-first (whisper.cpp)
    except Exception as e:  # noqa: BLE001 — erro de ASR não pode derrubar o fluxo
        return jsonify({"erro": f"falha na transcrição: {e}"}), 502
    finally:
        os.remove(audio_path)
    return jsonify(resultado)


@app.post("/api/extrair")
def api_extrair():
    """Passagem 1 completa: reorganiza o relato cru (Gemma) e extrai a ficha
    estruturada (Gemma). Devolve a ficha E o relato organizado."""
    data = request.get_json(force=True) or {}
    transcript = data.get("transcript", "")
    image_b64 = data.get("image_base64")
    image_path = _save_temp(base64.b64decode(image_b64), ".jpg") if image_b64 else None
    t0 = time.time()
    try:
        relato = estruturar_relato(transcript)
        ficha = extract(relato or transcript, image=image_path)
    finally:
        if image_path:
            os.remove(image_path)
    return jsonify({"ficha": ficha, "relato": relato, "ms": int((time.time() - t0) * 1000)})


@app.post("/api/narrar")
def api_narrar():
    data = request.get_json(force=True) or {}
    ficha_confirmada = data.get("ficha_confirmada") or {}
    cooperativa = data.get("cooperativa") or "Cooperativa Exemplo (Resex Chico Mendes)"
    t0 = time.time()
    narrativa = narrate(ficha_confirmada, cooperativa)
    return jsonify({"narrativa": narrativa, "ms": int((time.time() - t0) * 1000)})


# --------------------------------------------------------------------------- #
# Produtores (Fase 3) — cadastro + histórico + indicadores (scaffolding).
# --------------------------------------------------------------------------- #
@app.get("/api/produtores")
def api_listar_produtores():
    return jsonify(db.listar_produtores())


@app.post("/api/produtores")
def api_criar_produtor():
    data = request.get_json(force=True) or {}
    nome = (data.get("nome") or "").strip()
    if not nome:
        return jsonify({"erro": "nome é obrigatório"}), 400
    prod = db.criar_produtor(
        nome=nome, comunidade=(data.get("comunidade") or "").strip(),
        cooperativa=(data.get("cooperativa") or "").strip(),
        foto=data.get("foto"), lat=data.get("lat"), lng=data.get("lng"),
    )
    return jsonify(prod), 201


@app.get("/api/produtores/<int:produtor_id>")
def api_buscar_produtor(produtor_id):
    prod = db.buscar_produtor(produtor_id)
    if not prod:
        abort(404)
    # PERFORMANCE: db.buscar_produtor() traz o histórico com o dict COMPLETO de
    # cada lote (evidencias_json inclui as fotos em base64 — pode passar de 1 MB
    # por lote). A tela de perfil só usa produto/cooperativa/data/contagem de
    # evidências (ver histToResumo em screens.js) — nunca as imagens. Substitui
    # pelo resumo leve antes de serializar, senão o perfil de um produtor com
    # poucos lotes já respondia ~50 KB por causa de fotos que a UI descarta.
    prod["historico"] = [_lote_resumo(lo) for lo in prod.get("historico", [])]
    return jsonify(prod)


# --------------------------------------------------------------------------- #
# Lotes (listagem para dashboard/histórico/rastreabilidade) + denúncias.
# --------------------------------------------------------------------------- #
_ESSENCIAIS_LOTE = ("produtor", "coleta", "produto", "gemma", "confirmacao", "narrativa")


def _lote_resumo(lo: dict, nomes: Optional[dict] = None) -> dict:
    """Versão LEVE de um lote para listagens (sem as fotos em base64 da
    evidencias_json, que podem passar de 1 MB por lote). Toda tela de lista
    (painel, histórico, rastrear, perfil do produtor) usa só isto — nunca o
    dict bruto do banco — para não trafegar imagens que a UI nem exibe ali."""
    ev = lo.get("evidencias") or {}
    return {
        "slug": lo["slug"], "produto": lo["produto"], "cooperativa": lo["cooperativa"],
        "produtor_id": lo.get("produtor_id"),
        "produtor_nome": (nomes or {}).get(lo.get("produtor_id")),
        "criado_em": lo["criado_em"], "status": lo["status"],
        "evidencias_completas": sum(1 for k in _ESSENCIAIS_LOTE if k in ev),
        "url": f"/p/{lo['slug']}",
    }


@app.get("/api/lotes")
def api_listar_lotes():
    cooperativa = request.args.get("cooperativa")
    lotes = db.listar_lotes(cooperativa=cooperativa)
    # enriquece com o nome do produtor (uma consulta só, mapa em memória)
    nomes = {p["id"]: p["nome"] for p in db.listar_produtores()}
    return jsonify([_lote_resumo(lo, nomes) for lo in lotes])


@app.get("/api/resumo")
def api_resumo():
    """Números do painel (dashboard) — tudo calculado a partir de dados reais."""
    lotes = db.listar_lotes()
    produtores = db.listar_produtores()
    completos = sum(1 for lo in lotes
                    if all(k in (lo.get("evidencias") or {}) for k in _ESSENCIAIS_LOTE))
    coops = sorted({lo["cooperativa"] for lo in lotes if lo["cooperativa"]})
    produtos = sorted({lo["produto"] for lo in lotes if lo["produto"]})
    comunidades = sorted({p["comunidade"] for p in produtores if p.get("comunidade")})
    return jsonify({
        "total_lotes": len(lotes),
        "total_produtores": len(produtores),
        "lotes_rastreaveis_completos": completos,
        "cooperativas": coops,
        "produtos_distintos": produtos,
        "comunidades_atendidas": comunidades,
        "denuncias_abertas": sum(1 for d in db.listar_denuncias() if d["status"] == "aberta"),
    })


@app.get("/api/mapa_pontos")
def api_mapa_pontos():
    """Pontos reais de GPS (foto do produto/coleta/produtor) para o mapa simples
    do painel. Sem serviço de mapa externo (offline-first) — só as coordenadas.
    Uma única consulta ao banco (listar_lotes já traz as evidencias completas —
    reconsultar buscar_lote por lote aqui seria N+1 queries à toa)."""
    pontos = []
    for lo in db.listar_lotes():
        ev = lo.get("evidencias") or {}
        for chave in ("produto", "coleta", "produtor"):
            gps = (ev.get(chave) or {}).get("gps") or {}
            if gps.get("ok"):
                pontos.append({"lat": gps["lat"], "lng": gps["lng"],
                               "produto": lo["produto"], "slug": lo["slug"]})
                break  # 1 ponto por lote basta pro mapa
    return jsonify(pontos)


@app.get("/api/denuncias")
def api_listar_denuncias():
    return jsonify(db.listar_denuncias())


@app.post("/api/denuncias")
def api_criar_denuncia():
    data = request.get_json(force=True) or {}
    mensagem = (data.get("mensagem") or "").strip()
    if not mensagem:
        return jsonify({"erro": "mensagem é obrigatória"}), 400
    d = db.salvar_denuncia(mensagem=mensagem, slug=(data.get("slug") or "").strip(),
                           contato=(data.get("contato") or "").strip())
    return jsonify(d), 201


def _slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text or "lote"


def _qr_base64(url: str) -> str:
    img = qrcode.make(url)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


@app.post("/api/publicar")
def api_publicar():
    """Passo 10/11 do fluxo: gera slug, salva o lote confirmado e devolve
    a URL pública + o QR (PNG em base64) que aponta pra ela."""
    data = request.get_json(force=True) or {}
    ficha_confirmada = data.get("ficha_confirmada") or {}
    narrativa = data.get("narrativa") or ""
    cooperativa = data.get("cooperativa") or "Cooperativa Exemplo (Resex Chico Mendes)"
    evidencias = data.get("evidencias") or {}
    relato = data.get("relato") or ""
    produtor_id = data.get("produtor_id")
    produto = (ficha_confirmada.get("produto") or {}).get("value", "lote")

    slug = f"{_slugify(produto)}-{uuid.uuid4().hex[:6]}"
    db.salvar_lote(slug, produto, cooperativa, ficha_confirmada, narrativa,
                   evidencias=evidencias, relato=relato, produtor_id=produtor_id)

    url = request.host_url.rstrip("/") + "/p/" + slug
    return jsonify({"slug": slug, "url": url, "qr_base64": _qr_base64(url)})


_PUBLIC_PAGE = """<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>{{ produto }} — {{ cooperativa }}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='24' fill='%2315683a'/%3E%3Ctext y='72' x='50' font-size='58' text-anchor='middle'%3E%F0%9F%8C%BF%3C/text%3E%3C/svg%3E"/>
<style>
  :root{--verde-900:#0b3d1f;--verde-700:#15683a;--verde-600:#1f8043;--verde-500:#35a45a;
    --verde-100:#d9f2e0;--verde-50:#eff8f2;--bg:#f4f7f4;--card:#fff;--linha:#e7ece8;
    --texto:#0f1a12;--texto-suave:#5f6f64;--azul:#1565c0;--azul-bg:#e7f0fb;
    --laranja:#965000;--laranja-bg:#fdf0dd;--vermelho:#c62828;
    --sh:0 1px 2px rgba(11,61,31,.05),0 6px 20px rgba(11,61,31,.07)}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
    background:var(--bg);color:var(--texto);-webkit-font-smoothing:antialiased}
  header{background:linear-gradient(135deg,var(--verde-700),var(--verde-600));color:#fff;
    padding:26px 18px 30px;text-align:center}
  header .selo-cert{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.08em;
    text-transform:uppercase;background:rgba(255,255,255,.18);padding:5px 12px;border-radius:99px;margin-bottom:12px}
  header h1{margin:2px 0 4px;font-size:26px;letter-spacing:-.02em}
  header .sub{font-size:13px;opacity:.9}
  main{padding:0 16px 40px;max-width:640px;margin:-16px auto 0}
  .card{background:var(--card);border:1px solid var(--linha);border-radius:18px;padding:20px;
    margin-bottom:14px;box-shadow:var(--sh)}
  h2{font-size:12px;margin:0 0 14px;color:var(--verde-600);text-transform:uppercase;
    letter-spacing:.07em;font-weight:800}
  .campo{border-bottom:1px solid var(--linha);padding:10px 0;font-size:14px}
  .campo:last-child{border-bottom:0}
  .campo b{display:block;font-size:11px;color:var(--texto-suave);text-transform:capitalize;font-weight:700;margin-bottom:2px}
  .narrativa{font-size:16px;line-height:1.65;margin:0}
  .selo{font-size:12.5px;color:var(--texto-suave);margin-top:12px;line-height:1.5}
  .cadeia{list-style:none;margin:0;padding:0}
  .cadeia li{display:flex;gap:12px;padding:11px 0;border-bottom:1px solid var(--linha);align-items:center}
  .cadeia li:last-child{border-bottom:0}
  .cadeia .ci{width:30px;height:30px;border-radius:10px;flex:none;display:flex;align-items:center;
    justify-content:center;font-size:14px;background:#eef2ee;color:#9aa79f}
  .cadeia li.feito .ci{background:var(--verde-100);color:var(--verde-700)}
  .cadeia .cinfo{flex:1;min-width:0}
  .cadeia .ctitulo{font-size:14px;font-weight:700}
  .cadeia li.pendente .ctitulo{color:#9aa79f;font-weight:600}
  .cadeia .cmeta{font-size:11.5px;color:var(--texto-suave);margin-top:2px;word-break:break-word}
  .cadeia .cmeta .g{color:var(--azul)}
  .cadeia .cmeta .ng{color:var(--vermelho)}
  .cadeia .cthumb{width:52px;height:52px;object-fit:cover;border-radius:10px;flex:none;border:1px solid var(--linha)}
  .kicker{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.04em;
    background:var(--verde-100);color:var(--verde-700);padding:4px 10px;border-radius:99px;margin-bottom:10px}
  .idlote{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:var(--texto-suave);
    background:var(--verde-50);border:1px solid var(--verde-100);border-radius:10px;padding:8px 12px;
    display:inline-block;margin-top:6px}
  .selos-grid{display:flex;flex-wrap:wrap;gap:8px}
  .selo-badge{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;
    background:var(--verde-50);border:1px solid var(--verde-100);color:var(--verde-700);
    border-radius:12px;padding:8px 12px}
  .selo-badge.frac{background:var(--laranja-bg);border-color:#f6dfae;color:var(--laranja)}
  .qr-box{text-align:center}
  .qr-box img{width:168px;height:168px;border-radius:14px;border:1px solid var(--linha);padding:10px;background:#fff}
  .ia-info{font-size:13px;color:var(--texto);line-height:1.7;margin:0}
  .ia-info b{color:var(--verde-700)}
  .footer-cert{text-align:center;font-size:11.5px;color:var(--texto-suave);padding:6px 12px 28px;line-height:1.6}
</style>
</head>
<body>
<header>
  <span class="selo-cert">🌿 Certificado Digital de Rastreabilidade</span>
  <h1>{{ produto }}</h1>
  <div class="sub">Atestado por {{ cooperativa }} · BioAmazon IA</div>
</header>
<main>
  <div class="card" style="text-align:center">
    <span class="kicker">Nº DE RASTREIO</span><br/>
    <span class="idlote">{{ slug }}</span>
    <p class="selo" style="margin-bottom:0">Emitido em {{ data_emissao }}</p>
  </div>

  {% if selos %}
  <div class="card">
    <h2>Selos verificados</h2>
    <div class="selos-grid">
      {% for s in selos %}
      <span class="selo-badge {{ '' if s.ok else 'frac' }}">{{ s.icon }} {{ s.label }}</span>
      {% endfor %}
    </div>
  </div>
  {% endif %}

  <div class="card">
    <h2>Jornada</h2>
    <p class="narrativa">{{ narrativa }}</p>
    <p class="selo">Narrativa gerada pelo Gemma a partir apenas dos fatos confirmados pelo operador.</p>
  </div>

  <div class="card qr-box">
    <h2 style="text-align:left">Compartilhar este certificado</h2>
    <img src="data:image/png;base64,{{ qr_base64 }}" alt="QR code deste lote"/>
    <p class="selo">Escaneie para abrir esta mesma página em outro dispositivo.</p>
  </div>

  {% if produtor %}
  <div class="card">
    <h2>Produtor</h2>
    <div style="display:flex;gap:14px;align-items:center">
      {% if produtor.foto %}<img src="{{ produtor.foto }}" style="width:58px;height:58px;border-radius:50%;object-fit:cover;border:1px solid var(--linha)"/>{% endif %}
      <div>
        <div style="font-weight:800;font-size:15px">{{ produtor.nome }}</div>
        <div class="selo" style="margin:2px 0 0">
          {{ produtor.comunidade }}{% if produtor.comunidade and produtor.cooperativa %} · {% endif %}{{ produtor.cooperativa }}</div>
        <div class="selo" style="margin:2px 0 0">{{ produtor.indicadores.total_lotes }} lote(s) rastreado(s) · cód. {{ produtor.codigo }}</div>
      </div>
    </div>
  </div>
  {% endif %}

  {% if relato %}
  <div class="card">
    <h2>Descrição da coleta</h2>
    <p class="narrativa" style="font-size:15px">{{ relato }}</p>
    <p class="selo">Relato do produtor, organizado pelo Gemma — sem fatos inventados, apenas reorganizado.</p>
  </div>
  {% endif %}

  <div class="card">
    <h2>Ficha técnica</h2>
    {% for k, v in ficha.items() %}
    <div class="campo"><b>{{ k.replace("_", " ") }}</b>{{ v.value }}</div>
    {% endfor %}
    <p class="selo">Todos os campos foram revisados e confirmados por um operador humano
      antes da publicação (loop de confiança).</p>
  </div>

  {% if ia_info %}
  <div class="card">
    <h2>Como este certificado foi gerado</h2>
    <p class="ia-info">{{ ia_info | safe }}</p>
  </div>
  {% endif %}

  {% if cadeia %}
  <div class="card">
    <h2>Cadeia de evidências</h2>
    <ul class="cadeia">
      {% for item in cadeia %}
      <li class="{{ 'feito' if item.feito else 'pendente' }}">
        {% if item.image %}<img class="cthumb" src="{{ item.image }}" alt="{{ item.titulo }}"/>
        {% else %}<span class="ci">{{ '✓' if item.feito else item.icon }}</span>{% endif %}
        <span class="cinfo"><span class="ctitulo">{{ item.titulo }}</span>
          {% if item.meta %}<span class="cmeta">{{ item.meta | safe }}</span>{% endif %}</span>
      </li>
      {% endfor %}
    </ul>
    <p class="selo" style="margin-top:12px">Localização exibida de forma aproximada por privacidade;
      a coordenada exata fica registrada com a cooperativa para auditoria.</p>
  </div>
  {% endif %}

  <p class="footer-cert">Este certificado é gerado automaticamente pelo BioAmazon IA a partir de
    dados capturados em campo e confirmados por um operador humano. 🌳</p>
</main>
</body>
</html>"""


# Definição da cadeia de evidências. Espelha CADEIA em frontend/app.js (mesma
# ordem/chaves/rótulos, mesmo padrão de duplicação intencional que FICHA_FIELDS —
# ver CLAUDE.md). Se adicionar/remover um elo aqui, replique lá também.
_CADEIA_DEF = [
    ("produtor", "👤", "Foto do produtor"),
    ("coleta", "🌴", "Foto da coleta"),
    ("produto", "🫐", "Foto do produto"),
    ("audio", "🎙️", "Relato em áudio do produtor"),
    ("gemma", "🤖", "Análise do Gemma (ficha técnica)"),
    ("confirmacao", "✔️", "Confirmação do operador"),
    ("narrativa", "📖", "Narrativa final"),
]


def _fmt_hora(iso: str) -> str:
    """ISO (UTC, do navegador) -> 'DD/MM/AAAA HH:MM'. Tolerante a formato."""
    if not iso:
        return ""
    try:
        from datetime import datetime
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return dt.strftime("%d/%m/%Y %H:%M")
    except Exception:  # noqa: BLE001
        return iso[:16].replace("T", " ")


def _gps_publico(gps: dict) -> str:
    """PRIVACIDADE: em público mostramos a localização com precisão REDUZIDA
    (~1 km, 2 casas decimais). A coordenada exata fica só no banco, para auditoria
    da cooperativa — não expomos a casa/roçado de ninguém num QR público."""
    if not gps or not gps.get("ok"):
        from markupsafe import escape
        motivo = escape((gps or {}).get("motivo", "não registrado"))
        return f'<span class="ng">sem GPS — {motivo}</span>'
    lat, lng = round(float(gps["lat"]), 2), round(float(gps["lng"]), 2)
    return f'<span class="g">📍 ~{lat}, {lng} (aprox.)</span>'


def _prep_cadeia(evidencias: dict) -> list:
    itens = []
    for key, icon, titulo in _CADEIA_DEF:
        ev = evidencias.get(key)
        item = {"icon": icon, "titulo": titulo, "feito": bool(ev),
                "image": None, "meta": ""}
        if ev:
            if key in ("produtor", "coleta", "produto"):
                fonte = "📷 câmera ao vivo" if ev.get("fonte") == "camera" else "📎 arquivo"
                item["image"] = ev.get("image")
                item["meta"] = f'{fonte} · {_fmt_hora(ev.get("timestamp"))} · {_gps_publico(ev.get("gps"))}'
            else:
                item["meta"] = _fmt_hora(ev.get("timestamp"))
        itens.append(item)
    return itens


_ESSENCIAIS = ("produtor", "coleta", "produto", "gemma", "confirmacao", "narrativa")


def _monta_ia_info(ev: dict) -> str:
    """Texto factual sobre COMO este lote específico foi processado — só afirma
    'local'/'nuvem' quando o dado foi realmente registrado na captura (evidencias
    .gemma/.narrativa.local); para lotes antigos sem esse dado, fica genérico em
    vez de inventar. Nunca afirmamos Gemini quando o backend ativo é local."""
    partes = []
    g, n = ev.get("gemma") or {}, ev.get("narrativa") or {}
    if "local" in g:
        partes.append("A ficha técnica foi extraída pelo <b>Gemma rodando localmente no "
                       "dispositivo</b> (Edge AI)" if g["local"] else
                       "A ficha técnica foi extraída pelo Gemma via nuvem (fallback remoto)")
    else:
        partes.append("A ficha técnica foi extraída pelo Gemma")
    if "local" in n:
        partes.append("a narrativa foi gerada <b>localmente, sem envio de dados à internet</b>"
                       if n["local"] else "a narrativa foi gerada via nuvem (fallback remoto)")
    else:
        partes.append("a narrativa foi gerada pelo Gemma")
    return "; ".join(partes) + ". A transcrição da fala, quando por áudio, roda com whisper.cpp offline."


def _monta_selos(registro: dict, produtor: Optional[dict]) -> list:
    ev = registro.get("evidencias") or {}
    completa = all(k in ev for k in _ESSENCIAIS)
    gps_ok = any((ev.get(k) or {}).get("gps", {}).get("ok") for k in ("produtor", "coleta", "produto"))
    ia_local = bool((ev.get("gemma") or {}).get("local")) or bool((ev.get("narrativa") or {}).get("local"))
    return [
        {"icon": "🔗", "label": "Rastreabilidade completa", "ok": completa},
        {"icon": "📍", "label": "Localização por GPS", "ok": gps_ok},
        {"icon": "👤", "label": "Produtor identificado", "ok": bool(produtor)},
        {"icon": "📴", "label": "Processado por IA local", "ok": ia_local},
    ]


@app.get("/p/<slug>")
def pagina_publica(slug):
    registro = db.buscar_lote(slug)
    if not registro:
        abort(404)
    produto = (registro["ficha_confirmada"].get("produto") or {}).get("value", "Produto")
    cadeia = _prep_cadeia(registro.get("evidencias") or {})
    produtor = db.buscar_produtor(registro["produtor_id"]) if registro.get("produtor_id") else None
    url = request.host_url.rstrip("/") + "/p/" + slug
    return render_template_string(
        _PUBLIC_PAGE, produto=produto, narrativa=registro["narrativa"],
        cooperativa=registro["cooperativa"], ficha=registro["ficha_confirmada"],
        cadeia=cadeia, relato=registro.get("relato") or "", produtor=produtor,
        slug=slug, data_emissao=_fmt_hora(registro.get("criado_em", "")) or registro.get("criado_em", ""),
        qr_base64=_qr_base64(url), selos=_monta_selos(registro, produtor),
        ia_info=_monta_ia_info(registro.get("evidencias") or {}),
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=True)
