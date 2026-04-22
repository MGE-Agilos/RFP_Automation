import sqlite3
import json
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent / "data" / "rfp_automation.db"


def get_conn():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    DB_PATH.parent.mkdir(exist_ok=True)
    with get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS email_scans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT,
                subject TEXT,
                markets_found INTEGER DEFAULT 0,
                scanned_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS markets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scan_id INTEGER REFERENCES email_scans(id),
                title TEXT NOT NULL,
                original_url TEXT,
                resolved_url TEXT,
                category TEXT,
                deadline TEXT,
                published_date TEXT,
                contracting_authority TEXT,
                description TEXT,
                full_content TEXT,
                status TEXT DEFAULT 'pending',
                is_relevant INTEGER,
                relevance_score INTEGER,
                relevance_reason TEXT,
                rfp_content TEXT,
                rfp_generated_at TEXT,
                error_message TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status);
            CREATE INDEX IF NOT EXISTS idx_markets_is_relevant ON markets(is_relevant);
        """)


def add_scan(filename: str, subject: str, count: int) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO email_scans (filename, subject, markets_found) VALUES (?, ?, ?)",
            (filename, subject, count),
        )
        return cur.lastrowid


def add_market(data: dict) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO markets
               (scan_id, title, original_url, resolved_url, category, deadline,
                published_date, contracting_authority, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')""",
            (
                data.get("scan_id"),
                data["title"],
                data.get("original_url"),
                data.get("resolved_url"),
                data.get("category"),
                data.get("deadline"),
                data.get("published_date"),
                data.get("contracting_authority"),
            ),
        )
        return cur.lastrowid


def update_market_scan(market_id: int, data: dict):
    with get_conn() as conn:
        conn.execute(
            """UPDATE markets SET
               description=?, full_content=?, resolved_url=?,
               status='scanned', updated_at=datetime('now')
               WHERE id=?""",
            (data.get("description"), data.get("full_content"), data.get("resolved_url"), market_id),
        )


def update_market_status(market_id: int, status: str, error: str = None):
    with get_conn() as conn:
        conn.execute(
            "UPDATE markets SET status=?, error_message=?, updated_at=datetime('now') WHERE id=?",
            (status, error, market_id),
        )


def update_market_analysis(market_id: int, data: dict):
    with get_conn() as conn:
        conn.execute(
            """UPDATE markets SET
               is_relevant=?, relevance_score=?, relevance_reason=?,
               status='analyzed', updated_at=datetime('now')
               WHERE id=?""",
            (
                1 if data.get("is_relevant") else 0,
                data.get("relevance_score", 0),
                data.get("relevance_reason"),
                market_id,
            ),
        )


def update_market_rfp(market_id: int, rfp_content: str):
    with get_conn() as conn:
        conn.execute(
            """UPDATE markets SET
               rfp_content=?, rfp_generated_at=datetime('now'), updated_at=datetime('now')
               WHERE id=?""",
            (rfp_content, market_id),
        )


def get_market(market_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM markets WHERE id=?", (market_id,)).fetchone()
        return dict(row) if row else None


def get_all_markets(filter_by: str = "all") -> list[dict]:
    query = "SELECT * FROM markets"
    params = []
    if filter_by == "relevant":
        query += " WHERE is_relevant=1"
    elif filter_by == "not_relevant":
        query += " WHERE is_relevant=0"
    elif filter_by == "pending":
        query += " WHERE status IN ('pending', 'scanning', 'analyzing')"
    elif filter_by == "rfp":
        query += " WHERE rfp_content IS NOT NULL"
    query += " ORDER BY created_at DESC"
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]


def get_pending_markets() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM markets WHERE status IN ('pending', 'scanned') ORDER BY id"
        ).fetchall()
        return [dict(r) for r in rows]


def get_stats() -> dict:
    with get_conn() as conn:
        total = conn.execute("SELECT COUNT(*) FROM markets").fetchone()[0]
        relevant = conn.execute("SELECT COUNT(*) FROM markets WHERE is_relevant=1").fetchone()[0]
        not_relevant = conn.execute("SELECT COUNT(*) FROM markets WHERE is_relevant=0").fetchone()[0]
        pending = conn.execute(
            "SELECT COUNT(*) FROM markets WHERE status IN ('pending','scanning','analyzing','scanned')"
        ).fetchone()[0]
        rfp_ready = conn.execute(
            "SELECT COUNT(*) FROM markets WHERE rfp_content IS NOT NULL"
        ).fetchone()[0]
        scans = conn.execute("SELECT COUNT(*) FROM email_scans").fetchone()[0]
    return {
        "total": total,
        "relevant": relevant,
        "not_relevant": not_relevant,
        "pending": pending,
        "rfp_ready": rfp_ready,
        "scans": scans,
    }


def get_recent_scans(limit: int = 10) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM email_scans ORDER BY scanned_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [dict(r) for r in rows]


def delete_market(market_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM markets WHERE id=?", (market_id,))
