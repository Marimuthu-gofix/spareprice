from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, redirect, render_template, request, url_for


ROOT = Path(__file__).resolve().parent
DEFAULT_DB = ROOT / "price_history.sqlite3"
DEFAULT_CONFIG = ROOT / "config.json"
HOSTED_READ_ONLY = bool(os.environ.get("VERCEL"))

app = Flask(__name__)
job_lock = threading.Lock()
job_state: dict[str, Any] = {
    "id": None,
    "running": False,
    "started_at": None,
    "finished_at": None,
    "returncode": None,
    "message": "Ready",
    "output": "",
}


def db_path() -> Path:
    configured = app.config.get("DB_PATH") or os.environ.get("DB_PATH")
    if not configured:
        return DEFAULT_DB
    path = Path(configured)
    if not path.exists() and DEFAULT_DB.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(DEFAULT_DB, path)
    return path


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    ensure_schema(conn)
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS price_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            brand TEXT NOT NULL,
            model TEXT NOT NULL,
            part TEXT NOT NULL,
            price TEXT,
            price_value REAL,
            currency TEXT,
            url TEXT NOT NULL,
            status TEXT NOT NULL,
            error TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_price_history_lookup
        ON price_history (brand, model, part, date)
        """
    )
    conn.commit()


def money(value: float | None, currency: str | None) -> str:
    if value is None:
        return "-"
    prefix = "Rs " if currency == "INR" else f"{currency} " if currency else ""
    return f"{prefix}{value:,.0f}"


@app.template_filter("money")
def money_filter(value: float | None, currency: str | None = None) -> str:
    return money(value, currency)


@app.template_filter("localdate")
def localdate_filter(value: str | None) -> str:
    if not value:
        return "-"
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.strftime("%d %b %Y, %H:%M")
    except ValueError:
        return value


PER_PAGE_OPTIONS = [25, 50, 100, 250]


def load_dashboard(search: str = "", brand: str = "", page: int = 1, per_page: int = 100) -> dict[str, Any]:
    conn = connect()
    rows = conn.execute(
        """
        SELECT date, brand, model, part, price, price_value, currency, status, error, url
        FROM price_history
        ORDER BY date DESC
        """
    ).fetchall()
    conn.close()

    latest_by_key: dict[tuple[str, str, str], sqlite3.Row] = {}
    for row in reversed(rows):
        key = (row["brand"], row["model"], row["part"])
        if row["status"] == "ok":
            latest_by_key[key] = row

    brands = sorted({row["brand"] for row in rows} | {row["brand"] for row in latest_by_key.values()})
    latest = sorted(latest_by_key.values(), key=lambda r: (r["brand"], r["model"], r["part"]))
    if brand:
        latest = [row for row in latest if row["brand"].lower() == brand.lower()]
        rows = [row for row in rows if row["brand"].lower() == brand.lower()]
    if search:
        needle = search.lower()
        latest = [
            row
            for row in latest
            if needle in " ".join([row["brand"], row["model"], row["part"], row["price"] or ""]).lower()
        ]
        rows = [
            row
            for row in rows
            if needle
            in " ".join([row["brand"], row["model"], row["part"], row["price"] or "", row["status"]]).lower()
        ]

    latest_total = len(latest)
    per_page = per_page if per_page in PER_PAGE_OPTIONS else 100
    total_pages = max(1, (latest_total + per_page - 1) // per_page)
    page = min(max(page, 1), total_pages)
    page_start = (page - 1) * per_page
    page_end = page_start + per_page
    paged_latest = latest[page_start:page_end]

    chart_limit = 24 if search else 12
    chart_candidates = sorted(latest, key=lambda r: r["date"], reverse=True)[:chart_limit]
    chart_keys = {(row["brand"], row["model"], row["part"]) for row in chart_candidates}
    history_by_key: defaultdict[tuple[str, str, str], list[sqlite3.Row]] = defaultdict(list)
    for row in reversed(rows):
        key = (row["brand"], row["model"], row["part"])
        if row["status"] == "ok" and key in chart_keys:
            history_by_key[key].append(row)

    chart_series = []
    for key in chart_keys:
        points = history_by_key.get(key, [])
        chart_series.append(
            {
                "label": " - ".join(key),
                "points": [
                    {"date": row["date"], "value": row["price_value"], "price": money(row["price_value"], row["currency"])}
                    for row in points
                    if row["price_value"] is not None
                ],
            }
        )
    chart_series.sort(key=lambda item: item["label"])

    successful_rows = [row for row in rows if row["status"] == "ok"]
    error_rows = [row for row in rows if row["status"] != "ok"]
    total_value = sum(row["price_value"] or 0 for row in latest)
    chart_note = f"Showing {len(chart_series)} chart series"
    if len(latest) > len(chart_series):
        chart_note += f" from {len(latest)} matching prices. Search a model or spare part for a focused chart."

    return {
        "latest": paged_latest,
        "history": rows[:100],
        "brands": brands,
        "per_page_options": PER_PAGE_OPTIONS,
        "pagination": {
            "page": page,
            "per_page": per_page,
            "total": latest_total,
            "total_pages": total_pages,
            "start": page_start + 1 if latest_total else 0,
            "end": min(page_end, latest_total),
            "has_prev": page > 1,
            "has_next": page < total_pages,
            "prev_page": max(1, page - 1),
            "next_page": min(total_pages, page + 1),
        },
        "chart_json": json.dumps(chart_series),
        "chart_note": chart_note,
        "stats": {
            "tracked": len(latest),
            "brands": len({row["brand"] for row in latest}),
            "checks": len(rows),
            "errors": len(error_rows),
            "total_value": total_value,
            "last_success": successful_rows[0]["date"] if successful_rows else None,
        },
        "job": current_job_state(),
        "hosted_read_only": HOSTED_READ_ONLY,
    }


@app.route("/")
def index() -> str:
    search = request.args.get("q", "").strip()
    brand = request.args.get("brand", "").strip()
    page = parse_positive_int(request.args.get("page"), 1)
    per_page = parse_positive_int(request.args.get("per_page"), 100)
    data = load_dashboard(search=search, brand=brand, page=page, per_page=per_page)
    return render_template(
        "dashboard.html",
        search=search,
        selected_brand=brand,
        selected_per_page=data["pagination"]["per_page"],
        **data,
    )


def parse_positive_int(value: str | None, default: int) -> int:
    try:
        parsed = int(value or "")
    except ValueError:
        return default
    return parsed if parsed > 0 else default


@app.post("/check-now")
def check_now() -> Any:
    if HOSTED_READ_ONLY:
        return hosted_read_only_response()
    started = start_job("shortlist")
    if request.headers.get("Accept") == "application/json":
        return jsonify(current_job_state()), (202 if started else 409)
    return redirect(url_for("index"))


@app.post("/discover-all")
def discover_all_now() -> Any:
    if HOSTED_READ_ONLY:
        return hosted_read_only_response()
    started = start_job("catalog")
    if request.headers.get("Accept") == "application/json":
        return jsonify(current_job_state()), (202 if started else 409)
    return redirect(url_for("index"))


@app.get("/job-status")
def job_status() -> Any:
    return jsonify(current_job_state())


def hosted_read_only_response() -> Any:
    payload = current_job_state()
    payload["message"] = "Hosted dashboard is read-only"
    payload["output"] = "Run the scraper locally, commit the updated database, then push to refresh Vercel."
    if request.headers.get("Accept") == "application/json":
        return jsonify(payload), 409
    return redirect(url_for("index"))


def current_job_state() -> dict[str, Any]:
    with job_lock:
        return dict(job_state)


def start_job(job_type: str) -> bool:
    with job_lock:
        if job_state["running"]:
            return False
        message = "Checking all configured devices..."
        if job_type == "catalog":
            message = "Discovering all supported mobile model and spare-part prices..."
        job_state.update(
            {
                "id": str(uuid.uuid4()),
                "running": True,
                "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "finished_at": None,
                "returncode": None,
                "message": message,
                "output": "",
            }
        )
    thread = threading.Thread(target=run_tracker_command, args=(job_type,), daemon=True)
    thread.start()
    return True


def run_tracker_command(job_type: str) -> None:
    if job_type == "catalog":
        command = [sys.executable, str(ROOT / "spareprice.py"), "discover-all", "--brand", "all", "--delay", "1"]
    else:
        command = [sys.executable, str(ROOT / "spareprice.py"), "run", "--config", str(DEFAULT_CONFIG)]
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=3600,
            check=False,
        )
        output = "\n".join(part for part in [result.stdout, result.stderr] if part).strip()
        message = "Price check complete" if result.returncode == 0 else "Price check finished with errors"
        if job_type == "catalog":
            message = "Catalog discovery complete" if result.returncode == 0 else "Catalog discovery finished with errors"
        with job_lock:
            job_state.update(
                {
                    "running": False,
                    "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "returncode": result.returncode,
                    "message": message,
                    "output": output[-6000:],
                }
            )
    except Exception as exc:
        with job_lock:
            job_state.update(
                {
                    "running": False,
                    "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "returncode": -1,
                    "message": f"Price check failed: {type(exc).__name__}",
                    "output": str(exc),
                }
            )


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True, use_reloader=False)
