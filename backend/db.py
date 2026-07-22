"""
Persistência — SQLite (stdlib, zero credencial, zero serviço externo).

Duas entidades:
  • lotes      — cada lote publicado (ficha + narrativa + relato + cadeia de evidências).
  • produtores — cadastro do produtor (Fase 3), base do histórico de produção sustentável.
    Um lote referencia um produtor por `produtor_id` (opcional, compatível com o legado).

Filosofia mantida: dados ricos e variáveis (ficha, evidências, indicadores) ficam como
JSON em coluna; campos usados para consulta/listagem são colunas reais. Nada exige, por
ora, normalização campo a campo.
"""
from __future__ import annotations
import json
import os
import sqlite3
import uuid
from typing import Optional

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bioamazon.db")

_SCHEMA_LOTES = """
CREATE TABLE IF NOT EXISTS lotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    produto TEXT NOT NULL,
    cooperativa TEXT NOT NULL,
    ficha_json TEXT NOT NULL,
    narrativa TEXT NOT NULL,
    relato TEXT NOT NULL DEFAULT '',
    evidencias_json TEXT NOT NULL DEFAULT '{}',
    produtor_id INTEGER,
    status TEXT NOT NULL DEFAULT 'publicado',
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

_SCHEMA_PRODUTORES = """
CREATE TABLE IF NOT EXISTS produtores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT UNIQUE NOT NULL,
    nome TEXT NOT NULL,
    comunidade TEXT NOT NULL DEFAULT '',
    cooperativa TEXT NOT NULL DEFAULT '',
    foto TEXT,
    lat REAL,
    lng REAL,
    indicadores_json TEXT NOT NULL DEFAULT '{}',
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

_SCHEMA_DENUNCIAS = """
CREATE TABLE IF NOT EXISTS denuncias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT,
    mensagem TEXT NOT NULL,
    contato TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'aberta',
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _add_column_if_missing(conn, table, coluna, ddl) -> None:
    cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
    if coluna not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def init_db() -> None:
    with _connect() as conn:
        conn.execute(_SCHEMA_LOTES)
        conn.execute(_SCHEMA_PRODUTORES)
        conn.execute(_SCHEMA_DENUNCIAS)
        # migrações idempotentes (bancos criados em fases anteriores).
        _add_column_if_missing(conn, "lotes", "evidencias_json",
                               "evidencias_json TEXT NOT NULL DEFAULT '{}'")
        _add_column_if_missing(conn, "lotes", "relato", "relato TEXT NOT NULL DEFAULT ''")
        _add_column_if_missing(conn, "lotes", "produtor_id", "produtor_id INTEGER")


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "slug": row["slug"], "produto": row["produto"], "cooperativa": row["cooperativa"],
        "ficha_confirmada": json.loads(row["ficha_json"]), "narrativa": row["narrativa"],
        "relato": row["relato"] if "relato" in row.keys() else "",
        "evidencias": json.loads(row["evidencias_json"] or "{}"),
        "produtor_id": row["produtor_id"] if "produtor_id" in row.keys() else None,
        "status": row["status"], "criado_em": row["criado_em"],
    }


def salvar_lote(slug: str, produto: str, cooperativa: str, ficha_confirmada: dict,
                 narrativa: str, evidencias: Optional[dict] = None, relato: str = "",
                 produtor_id: Optional[int] = None, status: str = "publicado") -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO lotes (slug, produto, cooperativa, ficha_json, narrativa, "
            "relato, evidencias_json, produtor_id, status) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (slug, produto, cooperativa, json.dumps(ficha_confirmada, ensure_ascii=False),
             narrativa, relato, json.dumps(evidencias or {}, ensure_ascii=False),
             produtor_id, status),
        )


def buscar_lote(slug: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM lotes WHERE slug = ?", (slug,)).fetchone()
    return _row_to_dict(row) if row else None


def listar_lotes(cooperativa: Optional[str] = None,
                 produtor_id: Optional[int] = None) -> list[dict]:
    clauses, params = [], []
    if cooperativa:
        clauses.append("cooperativa = ?")
        params.append(cooperativa)
    if produtor_id is not None:
        clauses.append("produtor_id = ?")
        params.append(produtor_id)
    query = "SELECT * FROM lotes"
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY criado_em DESC"
    with _connect() as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
    return [_row_to_dict(r) for r in rows]


# --------------------------------------------------------------------------- #
# Produtores (Fase 3) — cadastro + histórico + base para indicadores.
# --------------------------------------------------------------------------- #
def _produtor_row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"], "codigo": row["codigo"], "nome": row["nome"],
        "comunidade": row["comunidade"], "cooperativa": row["cooperativa"],
        "foto": row["foto"], "lat": row["lat"], "lng": row["lng"],
        "indicadores": json.loads(row["indicadores_json"] or "{}"),
        "criado_em": row["criado_em"],
    }


def criar_produtor(nome: str, comunidade: str = "", cooperativa: str = "",
                   foto: Optional[str] = None, lat: Optional[float] = None,
                   lng: Optional[float] = None) -> dict:
    codigo = "PROD-" + uuid.uuid4().hex[:6].upper()
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO produtores (codigo, nome, comunidade, cooperativa, foto, lat, lng) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (codigo, nome, comunidade, cooperativa, foto, lat, lng),
        )
        pid = cur.lastrowid
    return buscar_produtor(pid)


def listar_produtores() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM produtores ORDER BY nome COLLATE NOCASE").fetchall()
    return [_resumo_produtor(_produtor_row_to_dict(r)) for r in rows]


def buscar_produtor(produtor_id: int) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM produtores WHERE id = ?", (produtor_id,)).fetchone()
    if not row:
        return None
    prod = _produtor_row_to_dict(row)
    prod["historico"] = listar_lotes(produtor_id=produtor_id)
    prod["indicadores"] = calcular_indicadores(prod)
    return prod


def _resumo_produtor(prod: dict) -> dict:
    """Versão leve para listagem (sem o histórico completo), com contagem de lotes."""
    with _connect() as conn:
        n = conn.execute("SELECT COUNT(*) c FROM lotes WHERE produtor_id = ?",
                         (prod["id"],)).fetchone()["c"]
    prod = dict(prod)
    prod["total_lotes"] = n
    return prod


def calcular_indicadores(prod: dict) -> dict:
    """SCAFFOLDING de indicadores de sustentabilidade (Fase 3).

    IMPORTANTE: NÃO é um sistema de pontuação — é só a ESTRUTURA sobre a qual um
    sistema de reconhecimento de boas práticas poderá ser construído. Hoje devolve
    agregados objetivos derivados do histórico + campos extensíveis (vazios) que
    regras futuras poderão preencher, sem mudar o schema. Ver [[bioamazon-roadmap]].
    """
    historico = prod.get("historico") or listar_lotes(produtor_id=prod["id"])
    total = len(historico)

    def cadeia_completa(lote) -> bool:
        ev = lote.get("evidencias") or {}
        essenciais = ("produtor", "coleta", "produto", "gemma", "confirmacao", "narrativa")
        return all(k in ev for k in essenciais)

    rastreados = sum(1 for lo in historico if cadeia_completa(lo))
    datas = sorted(lo["criado_em"] for lo in historico) if historico else []
    guardados = prod.get("indicadores") or {}  # o que já foi persistido em indicadores_json
    return {
        # agregados objetivos (calculados agora)
        "total_lotes": total,
        "lotes_rastreaveis_completos": rastreados,
        "primeiro_registro": datas[0] if datas else None,
        "ultimo_registro": datas[-1] if datas else None,
        # campos extensíveis para a evolução futura (não preenchidos por regras ainda)
        "regularidade_entregas": guardados.get("regularidade_entregas"),
        "boas_praticas": guardados.get("boas_praticas", []),
        "projetos_sustentaveis": guardados.get("projetos_sustentaveis", []),
        "selos": guardados.get("selos", []),
    }


# --------------------------------------------------------------------------- #
# Denúncias (Fase 4) — canal público de transparência sobre um lote.
# --------------------------------------------------------------------------- #
def salvar_denuncia(mensagem: str, slug: str = "", contato: str = "") -> dict:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO denuncias (slug, mensagem, contato) VALUES (?, ?, ?)",
            (slug or None, mensagem, contato),
        )
        did = cur.lastrowid
        row = conn.execute("SELECT * FROM denuncias WHERE id = ?", (did,)).fetchone()
    return dict(row)


def listar_denuncias() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM denuncias ORDER BY criado_em DESC").fetchall()
    return [dict(r) for r in rows]
