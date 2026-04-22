"""Flask web application for RFP Automation — Agilos."""

import os
import json
import threading
import tempfile
from pathlib import Path
from datetime import datetime

from flask import (
    Flask,
    render_template,
    request,
    jsonify,
    redirect,
    url_for,
    send_file,
)

import database as db
from email_parser import parse_msg_file
from scanner import scrape_market
from analyzer import analyze_market, generate_rfp

app = Flask(__name__)
app.secret_key = os.urandom(24)

# --- background job tracking ---
_jobs: dict[int, str] = {}  # market_id → current step description
_jobs_lock = threading.Lock()


def _set_job(market_id: int, step: str):
    with _jobs_lock:
        _jobs[market_id] = step


def _clear_job(market_id: int):
    with _jobs_lock:
        _jobs.pop(market_id, None)


# ─────────────────────────────────────────────
# Web routes
# ─────────────────────────────────────────────


@app.route("/")
def index():
    filter_by = request.args.get("filter", "all")
    markets = db.get_all_markets(filter_by)
    stats = db.get_stats()
    recent_scans = db.get_recent_scans()
    return render_template(
        "index.html",
        markets=markets,
        stats=stats,
        recent_scans=recent_scans,
        active_filter=filter_by,
    )


@app.route("/market/<int:market_id>")
def market_detail(market_id: int):
    market = db.get_market(market_id)
    if not market:
        return "Marché introuvable", 404
    job_step = _jobs.get(market_id)
    return render_template("market.html", market=market, job_step=job_step)


# ─────────────────────────────────────────────
# API routes
# ─────────────────────────────────────────────


@app.route("/api/stats")
def api_stats():
    return jsonify(db.get_stats())


@app.route("/api/markets")
def api_markets():
    filter_by = request.args.get("filter", "all")
    markets = db.get_all_markets(filter_by)
    return jsonify(markets)


@app.route("/api/job-status")
def api_job_status():
    """Return currently running jobs (market_id → step)."""
    with _jobs_lock:
        return jsonify(dict(_jobs))


@app.route("/api/market/<int:market_id>")
def api_market(market_id: int):
    market = db.get_market(market_id)
    if not market:
        return jsonify({"error": "not found"}), 404
    return jsonify(market)


@app.route("/api/scan-email", methods=["POST"])
def api_scan_email():
    """Upload a .msg file and extract markets."""
    if "file" not in request.files:
        return jsonify({"error": "Aucun fichier fourni"}), 400

    file = request.files["file"]
    if not file.filename.lower().endswith(".msg"):
        return jsonify({"error": "Seuls les fichiers .msg sont acceptés"}), 400

    # Save to a temp file (needed by extract_msg)
    with tempfile.NamedTemporaryFile(suffix=".msg", delete=False) as tmp:
        file.save(tmp.name)
        tmp_path = tmp.name

    try:
        parsed = parse_msg_file(tmp_path)
    finally:
        os.unlink(tmp_path)

    markets_data = parsed["markets"]
    subject = parsed["subject"]

    if not markets_data:
        return jsonify({"error": "Aucun marché trouvé dans cet email"}), 400

    scan_id = db.add_scan(file.filename, subject, len(markets_data))

    market_ids = []
    for m in markets_data:
        m["scan_id"] = scan_id
        mid = db.add_market(m)
        market_ids.append(mid)

    # Start background analysis for all new markets
    threading.Thread(
        target=_process_markets_batch,
        args=(market_ids,),
        daemon=True,
    ).start()

    return jsonify(
        {
            "scan_id": scan_id,
            "subject": subject,
            "markets_found": len(markets_data),
            "market_ids": market_ids,
        }
    )


@app.route("/api/analyze/<int:market_id>", methods=["POST"])
def api_analyze(market_id: int):
    """Trigger (re)analysis of a single market."""
    market = db.get_market(market_id)
    if not market:
        return jsonify({"error": "Introuvable"}), 404
    threading.Thread(
        target=_process_single_market,
        args=(market_id,),
        daemon=True,
    ).start()
    return jsonify({"status": "started"})


@app.route("/api/generate-rfp/<int:market_id>", methods=["POST"])
def api_generate_rfp(market_id: int):
    """Generate (or regenerate) an RFP for a relevant market."""
    market = db.get_market(market_id)
    if not market:
        return jsonify({"error": "Introuvable"}), 404
    threading.Thread(
        target=_generate_rfp_job,
        args=(market_id,),
        daemon=True,
    ).start()
    return jsonify({"status": "started"})


@app.route("/api/delete/<int:market_id>", methods=["DELETE"])
def api_delete(market_id: int):
    db.delete_market(market_id)
    return jsonify({"status": "deleted"})


@app.route("/api/rfp/<int:market_id>/download")
def download_rfp(market_id: int):
    """Download RFP as a plain Markdown text file."""
    market = db.get_market(market_id)
    if not market or not market.get("rfp_content"):
        return "RFP non disponible", 404

    safe_title = "".join(c if c.isalnum() or c in " -_" else "_" for c in market["title"])[:60]
    filename = f"RFP_{safe_title}.md"

    import io
    buf = io.BytesIO(market["rfp_content"].encode("utf-8"))
    buf.seek(0)
    return send_file(buf, as_attachment=True, download_name=filename, mimetype="text/markdown")


# ─────────────────────────────────────────────
# Background workers
# ─────────────────────────────────────────────


def _process_markets_batch(market_ids: list[int]):
    for mid in market_ids:
        _process_single_market(mid)


def _process_single_market(market_id: int):
    """Full pipeline: scrape → analyze → generate RFP if relevant."""
    market = db.get_market(market_id)
    if not market:
        return

    # 1. Scrape if not already done
    if not market.get("full_content"):
        _set_job(market_id, "Scan de la page…")
        db.update_market_status(market_id, "scanning")
        url = market.get("resolved_url") or market.get("original_url", "")
        try:
            scan_data = scrape_market(url)
            db.update_market_scan(market_id, scan_data)
            market = db.get_market(market_id)
        except Exception as exc:
            db.update_market_status(market_id, "error", str(exc))
            _clear_job(market_id)
            return

    # 2. Analyze relevance
    _set_job(market_id, "Analyse par Claude…")
    db.update_market_status(market_id, "analyzing")
    try:
        analysis = analyze_market(market)
        db.update_market_analysis(market_id, analysis)
        market = db.get_market(market_id)
    except Exception as exc:
        db.update_market_status(market_id, "error", str(exc))
        _clear_job(market_id)
        return

    # 3. Auto-generate RFP if relevant
    if analysis.get("is_relevant"):
        _generate_rfp_job(market_id)
    else:
        _clear_job(market_id)


def _generate_rfp_job(market_id: int):
    market = db.get_market(market_id)
    if not market:
        return
    _set_job(market_id, "Génération du RFP…")
    try:
        rfp = generate_rfp(market)
        db.update_market_rfp(market_id, rfp)
    except Exception as exc:
        db.update_market_status(market_id, "error", str(exc))
    finally:
        _clear_job(market_id)


# ─────────────────────────────────────────────
# Startup
# ─────────────────────────────────────────────

if __name__ == "__main__":
    db.init_db()
    print("─" * 60)
    print(" RFP Automation — Agilos")
    print(" http://localhost:5000")
    print("─" * 60)
    app.run(debug=False, port=5000, threaded=True)
