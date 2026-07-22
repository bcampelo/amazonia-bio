"""
Persistência dos lotes publicados — SQLite (stdlib, zero credencial, zero serviço
externo). Substitui o armazenamento anterior em arquivos soltos (publicados/*.json).

Schema mínimo pro MVP: a ficha completa (9 campos com value+provenance) fica como
JSON numa coluna — não há necessidade de normalizar campo a campo agora — mas slug,
produto, cooperativa, status e criado_em são colunas reais para dar suporte a telas
futuras de consulta/histórico/dashboard sem precisar reabrir e reprocessar JSON.
"""
from __future__ import annotations
import json
import os
import sqlite3
from typing import Optional

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bioamazon.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS lotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    produto TEXT NOT NULL,
    cooperativa TEXT NOT NULL,
    ficha_json TEXT NOT NULL,
    narrativa TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'publicado',
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.execute(_SCHEMA)


def _row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "slug": row["slug"], "produto": row["produto"], "cooperativa": row["cooperativa"],
        "ficha_confirmada": json.loads(row["ficha_json"]), "narrativa": row["narrativa"],
        "status": row["status"], "criado_em": row["criado_em"],
    }


def salvar_lote(slug: str, produto: str, cooperativa: str, ficha_confirmada: dict,
                 narrativa: str, status: str = "publicado") -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO lotes (slug, produto, cooperativa, ficha_json, narrativa, status) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (slug, produto, cooperativa, json.dumps(ficha_confirmada, ensure_ascii=False),
             narrativa, status),
        )


def buscar_lote(slug: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM lotes WHERE slug = ?", (slug,)).fetchone()
    return _row_to_dict(row) if row else None


def listar_lotes(cooperativa: Optional[str] = None) -> list[dict]:
    query = "SELECT * FROM lotes"
    params: tuple = ()
    if cooperativa:
        query += " WHERE cooperativa = ?"
        params = (cooperativa,)
    query += " ORDER BY criado_em DESC"
    with _connect() as conn:
        rows = conn.execute(query, params).fetchall()
    return [_row_to_dict(r) for r in rows]
