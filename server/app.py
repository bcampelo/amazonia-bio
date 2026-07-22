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
from backend.pipeline import extract, narrate  # noqa: E402

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


def _save_temp_image(image_base64: str) -> str:
    raw = base64.b64decode(image_base64)
    fd, path = tempfile.mkstemp(suffix=".jpg")
    with os.fdopen(fd, "wb") as f:
        f.write(raw)
    return path


@app.post("/api/extrair")
def api_extrair():
    data = request.get_json(force=True) or {}
    transcript = data.get("transcript", "")
    image_b64 = data.get("image_base64")
    image_path = _save_temp_image(image_b64) if image_b64 else None
    try:
        ficha = extract(transcript, image=image_path)
    finally:
        if image_path:
            os.remove(image_path)
    return jsonify(ficha)


@app.post("/api/narrar")
def api_narrar():
    data = request.get_json(force=True) or {}
    ficha_confirmada = data.get("ficha_confirmada") or {}
    cooperativa = data.get("cooperativa") or "Cooperativa Exemplo (Resex Chico Mendes)"
    narrativa = narrate(ficha_confirmada, cooperativa)
    return jsonify({"narrativa": narrativa})


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
    produto = (ficha_confirmada.get("produto") or {}).get("value", "lote")

    slug = f"{_slugify(produto)}-{uuid.uuid4().hex[:6]}"
    db.salvar_lote(slug, produto, cooperativa, ficha_confirmada, narrativa)

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
  <div class="card">
    <h2>Ficha do lote</h2>
    {% for k, v in ficha.items() %}
    <div class="campo"><b>{{ k.replace("_", " ") }}</b>{{ v.value }}</div>
    {% endfor %}
  </div>
</main>
</body>
</html>"""


@app.get("/p/<slug>")
def pagina_publica(slug):
    registro = db.buscar_lote(slug)
    if not registro:
        abort(404)
    produto = (registro["ficha_confirmada"].get("produto") or {}).get("value", "Produto")
    return render_template_string(
        _PUBLIC_PAGE, produto=produto, narrativa=registro["narrativa"],
        cooperativa=registro["cooperativa"], ficha=registro["ficha_confirmada"],
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=True)
