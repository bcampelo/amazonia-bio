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

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT_DIR)

import qrcode  # noqa: E402
from flask import Flask, abort, jsonify, request, render_template_string, send_from_directory  # noqa: E402

from backend import db  # noqa: E402
from backend.pipeline import extract, estruturar_relato, narrate  # noqa: E402
from backend.asr.transcribe import transcribe_audio  # noqa: E402

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
        transcript = transcribe_audio(audio_path)
    except Exception as e:  # noqa: BLE001 — erro de ASR não pode derrubar o fluxo
        return jsonify({"erro": f"falha na transcrição: {e}"}), 502
    finally:
        os.remove(audio_path)
    return jsonify({"transcript": transcript})


@app.post("/api/extrair")
def api_extrair():
    """Passagem 1 completa: reorganiza o relato cru (Gemma) e extrai a ficha
    estruturada (Gemma). Devolve a ficha E o relato organizado."""
    data = request.get_json(force=True) or {}
    transcript = data.get("transcript", "")
    image_b64 = data.get("image_base64")
    image_path = _save_temp(base64.b64decode(image_b64), ".jpg") if image_b64 else None
    try:
        relato = estruturar_relato(transcript)
        ficha = extract(relato or transcript, image=image_path)
    finally:
        if image_path:
            os.remove(image_path)
    return jsonify({"ficha": ficha, "relato": relato})


@app.post("/api/narrar")
def api_narrar():
    data = request.get_json(force=True) or {}
    ficha_confirmada = data.get("ficha_confirmada") or {}
    cooperativa = data.get("cooperativa") or "Cooperativa Exemplo (Resex Chico Mendes)"
    narrativa = narrate(ficha_confirmada, cooperativa)
    return jsonify({"narrativa": narrativa})


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
    return jsonify(prod)


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
<style>
  :root{--verde:#1b5e20;--verde2:#2e7d32;--bg:#f6f8f4}
  *{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  body{margin:0;background:var(--bg);color:#1a2016}
  header{background:var(--verde);color:#fff;padding:20px 16px}
  header h1{margin:0;font-size:22px}
  main{padding:16px;max-width:640px;margin:0 auto}
  .card{background:#fff;border:1px solid #e0e6dd;border-radius:14px;padding:18px;margin-bottom:14px}
  h2{font-size:13px;margin:0 0 10px;color:var(--verde2);text-transform:uppercase;letter-spacing:.04em}
  .campo{border-bottom:1px solid #e0e6dd;padding:8px 0;font-size:14px}
  .campo b{display:block;font-size:11px;color:#6b7663;text-transform:capitalize}
  .narrativa{font-size:16px;line-height:1.6}
  .selo{font-size:13px;color:#456;margin-top:12px}
  .cadeia{list-style:none;margin:0;padding:0}
  .cadeia li{display:flex;gap:11px;padding:11px 0;border-bottom:1px solid #e0e6dd}
  .cadeia li:last-child{border-bottom:0}
  .cadeia .ci{width:26px;height:26px;border-radius:50%;flex:none;display:flex;align-items:center;
    justify-content:center;font-size:13px;background:#eef3ea;color:#8a9683}
  .cadeia li.feito .ci{background:#d7ecd9;color:var(--verde)}
  .cadeia .cinfo{flex:1;min-width:0}
  .cadeia .ctitulo{font-size:14px;font-weight:600}
  .cadeia li.pendente .ctitulo{color:#9aa694;font-weight:500}
  .cadeia .cmeta{font-size:12px;color:#6b7663;margin-top:2px;word-break:break-word}
  .cadeia .cmeta .g{color:#1565c0}
  .cadeia .cmeta .ng{color:#c62828}
  .cadeia .cthumb{width:52px;height:52px;object-fit:cover;border-radius:8px;flex:none;border:1px solid #e0e6dd}
  .selo-rastro{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.03em;
    background:#d7ecd9;color:var(--verde);padding:4px 9px;border-radius:99px;margin-bottom:10px}
</style>
</head>
<body>
<header><h1>🌳 {{ produto }}</h1><div>Origem rastreada — BioAmazon IA</div></header>
<main>
  <div class="card">
    <h2>Jornada</h2>
    <p class="narrativa">{{ narrativa }}</p>
    <p class="selo">Atestado por {{ cooperativa }}</p>
  </div>
  {% if produtor %}
  <div class="card">
    <h2>Produtor</h2>
    <div style="display:flex;gap:12px;align-items:center">
      {% if produtor.foto %}<img src="{{ produtor.foto }}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:1px solid #e0e6dd"/>{% endif %}
      <div>
        <div style="font-weight:600">{{ produtor.nome }}</div>
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
    <p class="selo">Relato do produtor, organizado pelo Gemma — sem fatos inventados.</p>
  </div>
  {% endif %}
  <div class="card">
    <h2>Ficha do lote</h2>
    {% for k, v in ficha.items() %}
    <div class="campo"><b>{{ k.replace("_", " ") }}</b>{{ v.value }}</div>
    {% endfor %}
  </div>
  {% if cadeia %}
  <div class="card">
    <span class="selo-rastro">🔗 CADEIA DE EVIDÊNCIAS</span>
    <h2>Rastreabilidade verificável</h2>
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
</main>
</body>
</html>"""


# Definição da cadeia de evidências (mesma ordem/rótulos do app).
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


@app.get("/p/<slug>")
def pagina_publica(slug):
    registro = db.buscar_lote(slug)
    if not registro:
        abort(404)
    produto = (registro["ficha_confirmada"].get("produto") or {}).get("value", "Produto")
    cadeia = _prep_cadeia(registro.get("evidencias") or {})
    produtor = db.buscar_produtor(registro["produtor_id"]) if registro.get("produtor_id") else None
    return render_template_string(
        _PUBLIC_PAGE, produto=produto, narrativa=registro["narrativa"],
        cooperativa=registro["cooperativa"], ficha=registro["ficha_confirmada"],
        cadeia=cadeia, relato=registro.get("relato") or "", produtor=produtor,
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=True)
