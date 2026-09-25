from __future__ import annotations

import argparse
import asyncio
import base64
import csv
import json
import logging
import os
import re
import sqlite3
import sys
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import quote, urlencode

from price_store import RemotePriceStore

LOGGER = logging.getLogger("spareprice")
PRICE_RE = re.compile(
    r"(?P<currency>₹|Rs\.?|INR|USD|\$|EUR|€|GBP|£)?\s*(?P<amount>\d[\d,]*(?:\.\d{1,2})?)",
    re.IGNORECASE,
)
CURRENCY_PREFIX_PRICE_RE = re.compile(
    r"(?P<currency>₹|Rs\.?|INR|USD|\$|EUR|€|GBP|£)\s*(?P<amount>\d[\d,]*(?:\.\d{1,2})?)",
    re.IGNORECASE,
)
CURRENCY_SUFFIX_PRICE_RE = re.compile(
    r"(?P<amount>\d[\d,]*(?:\.\d{1,2})?)\s*(?P<currency>Rs\.?|INR|USD|EUR|GBP)",
    re.IGNORECASE,
)
OPPO_MOBILE_SERIES = [
    "Reno Series",
    "Find X Series",
    "A Series",
    "F Series",
    "K Series",
    "Find N Series",
    "R Series",
]
REALME_MOBILE_SERIES = [
    "GT Series",
    "Number Series",
    "P Series",
    "Narzo Series",
    "C Series",
    "Neo Series",
    "X Series",
    "U Series",
]
DISCOVERY_BRANDS = ["apple", "samsung", "oppo", "realme", "oneplus", "mi", "vivo", "iqoo", "motorola", "cashify"]
ONEPLUS_SUPPORT_URL = "https://service.oneplus.com/in/spare-parts-price#/"
ONEPLUS_API_BASE = "https://ind-sow-cms.oneplus.com/oppo-api"
MI_SUPPORT_URL = "https://www.mi.com/in/support/spare-part-prices/model?category=Mobile"
MI_API_BASE = "https://in-go.buy.mi.com/in/serviceplus/api/fos/public/v1/mi-store"
MI_API_AUTH = "Basic bWlzdG9yZS1zZXJ2aWNlcGx1cy1pbnRlZ3JhdGlvbjp4aWFvbWlAQURNSU4="
VIVO_SUPPORT_URL = "https://www.vivo.com/in/support/accessory"
IQOO_SUPPORT_URL = "https://www.iqoo.com/in/support/accessory"
MOTOROLA_SUPPORT_URL = "https://en-in.support.motorola.com/app/answers/detail/a_id/133816"
CASHIFY_REPAIR_URL = "https://www.cashify.in/repair"
# Cashify prices and availability depend on the chosen city, which the site
# keeps in two cookies. Values were read from the site after picking the city.
CASHIFY_CITIES: dict[str, dict[str, Any]] = {
    "chennai": {"ri": 333, "rn": "Chennai", "dp": 600027, "seo": "chennai"},
    "gurgaon": {"ri": 249, "rn": "Gurgaon", "dp": 122001, "seo": "gurgaon"},
}
DEFAULT_CASHIFY_CITY = "chennai"
# Words in a model name that identify its Cashify brand page.
CASHIFY_MODEL_BRAND_HINTS = {
    "iphone": "apple", "galaxy": "samsung", "pixel": "google", "redmi": "xiaomi", "poco": "poco",
    "narzo": "realme", "nord": "oneplus", "moto ": "motorola", "moto": "motorola", "edge ": "motorola",
    "reno": "oppo", "find ": "oppo", "iqoo": "iqoo", "nothing": "nothing", "infinix": "infinix",
    "honor": "honor", "nokia": "nokia", "asus": "asus", "rog ": "asus", "vivo": "vivo", "xiaomi": "xiaomi",
    "realme": "realme", "oneplus": "oneplus", "oppo": "oppo", "samsung": "samsung", "apple": "apple",
    "google": "google", "motorola": "motorola",
}


@dataclass(frozen=True)
class TrackerEntry:
    brand: str
    model: str
    part: str
    url: str
    currency: str | None
    actions: list[dict[str, Any]]
    price_selector: str


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def enabled_entries(config: dict[str, Any]) -> list[TrackerEntry]:
    entries = []
    for raw in config.get("entries", []):
        if raw.get("enabled", True) is False:
            continue
        entries.append(
            TrackerEntry(
                brand=required(raw, "brand"),
                model=required(raw, "model"),
                part=required(raw, "part"),
                url=required(raw, "url"),
                currency=raw.get("currency"),
                actions=list(raw.get("actions", [])),
                price_selector=required(raw, "price_selector"),
            )
        )
    return entries


def required(mapping: dict[str, Any], key: str) -> str:
    value = mapping.get(key)
    if not value:
        raise ValueError(f"Missing required config field: {key}")
    return str(value)


def default_db_path(fallback: str | Path) -> Path:
    return Path(os.environ.get("DB_PATH") or fallback)


def low_memory_mode() -> bool:
    """True on small hosts (Render sets RENDER=true) or when SCRAPE_LOW_MEMORY is set."""
    return bool(os.environ.get("SCRAPE_LOW_MEMORY") or os.environ.get("RENDER"))


def browser_launch_args() -> list[str]:
    args = ["--no-sandbox", "--disable-dev-shm-usage"]
    if low_memory_mode():
        # Trade speed and isolation for a much smaller footprint: one browser
        # process instead of one per site, no GPU, no extras. Needed to fit a
        # crawl next to the dashboard in a 512 MB instance.
        args += [
            "--no-zygote",
            "--disable-gpu",
            "--disable-software-rasterizer",
            "--disable-extensions",
            "--disable-default-apps",
            "--disable-background-networking",
            "--disable-background-timer-throttling",
            "--disable-features=IsolateOrigins,site-per-process,TranslateUI,MediaRouter",
            "--mute-audio",
            "--no-first-run",
        ]
    return args


# Requests the catalog crawlers never need. Skipping them makes every page
# load noticeably faster without changing how often a site is hit.
BLOCKED_RESOURCE_TYPES = {"image", "media", "font"}
BLOCKED_URL_FRAGMENTS = (
    "google-analytics.", "googletagmanager.", "doubleclick.", "facebook.", "hotjar.", "clarity.ms",
    "moengage", "webengage", "clevertap", "branch.io", "appsflyer", "newrelic", "sentry.io",
    "googlesyndication.", "adservice.", "googleadservices.", "criteo.", "taboola.", "outbrain.",
    "freshchat", "freshworks", "intercom", "zendesk", "tawk.to", "livechat", "onesignal", "pushengage",
    "amplitude.", "mixpanel.", "segment.io", "segment.com", "optimizely.", "fullstory.", "smartlook",
    "youtube.", "ytimg.", "vimeo.", "twitter.", "x.com/", "linkedin.", "pinterest.", "tiktok.", "snapchat.",
    "bing.com/bat", "bat.bing", "recaptcha", "gstatic.com/recaptcha", "firebase", "kissmetrics", "quantserve",
)


async def new_crawl_context(browser: Any) -> Any:
    context = await browser.new_context(locale="en-IN", viewport={"width": 1366, "height": 900})

    async def skip_heavy_requests(route: Any) -> None:
        request = route.request
        if request.resource_type in BLOCKED_RESOURCE_TYPES or any(
            fragment in request.url for fragment in BLOCKED_URL_FRAGMENTS
        ):
            await route.abort()
        else:
            await route.continue_()

    await context.route("**/*", skip_heavy_requests)
    return context


def model_matches_filter(model: str, model_filter: str | None) -> bool:
    if not model_filter:
        return True
    return model_filter.lower() in model.lower()


# Optional remote store (see hostinger_api/README.md). Every saved row also
# goes there when PRICE_API_URL and PRICE_API_KEY are set.
REMOTE_STORE = RemotePriceStore.from_env()


def connect_db(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
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
    return conn


def save_result(
    conn: sqlite3.Connection,
    entry: TrackerEntry,
    timestamp: str,
    price_text: str | None,
    price_value: float | None,
    currency: str | None,
    status: str,
    error: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO price_history
            (date, brand, model, part, price, price_value, currency, url, status, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            timestamp,
            entry.brand,
            entry.model,
            entry.part,
            price_text,
            price_value,
            currency or entry.currency,
            entry.url,
            status,
            error,
        ),
    )
    conn.commit()
    if REMOTE_STORE is not None:
        REMOTE_STORE.add(
            {
                "date": timestamp,
                "brand": entry.brand,
                "model": entry.model,
                "part": entry.part,
                "price": price_text,
                "price_value": price_value,
                "currency": currency or entry.currency,
                "url": entry.url,
                "status": status,
                "error": error,
            }
        )


async def run_tracker(config_path: Path) -> int:
    from playwright.async_api import async_playwright

    config = load_config(config_path)
    db_path = default_db_path(config.get("database_path", "price_history.sqlite3"))
    delay_seconds = float(config.get("delay_seconds", 6))
    timeout_ms = int(config.get("timeout_ms", 45000))
    headless = bool(config.get("headless", True))
    entries = enabled_entries(config)

    conn = connect_db(db_path)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=headless, args=browser_launch_args())
        context = await browser.new_context(
            locale="en-IN",
            viewport={"width": 1366, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/126.0.0.0 Safari/537.36"
            ),
        )
        for index, entry in enumerate(entries, start=1):
            timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
            LOGGER.info(
                "Checking %s/%s: %s - %s",
                index,
                len(entries),
                entry.model,
                entry.part,
            )
            page = await context.new_page()
            page.set_default_timeout(timeout_ms)
            try:
                price_text = await scrape_entry(page, entry)
                parsed_currency, price_value = parse_price(price_text)
                save_result(
                    conn,
                    entry,
                    timestamp,
                    price_text,
                    price_value,
                    parsed_currency or entry.currency,
                    "ok",
                )
                LOGGER.info("Saved %s %s %s: %s", entry.brand, entry.model, entry.part, price_text)
            except Exception as exc:
                message = f"{type(exc).__name__}: {exc}"
                LOGGER.exception(
                    "Failed %s %s %s; storing error and continuing",
                    entry.brand,
                    entry.model,
                    entry.part,
                )
                save_result(conn, entry, timestamp, None, None, entry.currency, "error", message)
            finally:
                await page.close()

            if index < len(entries):
                await asyncio.sleep(delay_seconds)

        await context.close()
        await browser.close()
    conn.close()
    flush_remote_store()
    return 0


async def dry_run(config_path: Path) -> int:
    from playwright.async_api import async_playwright

    config = load_config(config_path)
    timeout_ms = int(config.get("timeout_ms", 45000))
    entries = enabled_entries(config)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=False, args=browser_launch_args())
        context = await browser.new_context(locale="en-IN", viewport={"width": 1366, "height": 900})
        for entry in entries:
            page = await context.new_page()
            page.set_default_timeout(timeout_ms)
            try:
                price_text = await scrape_entry(page, entry)
                LOGGER.info("DRY RUN ok: %s %s %s => %s", entry.brand, entry.model, entry.part, price_text)
            except Exception:
                LOGGER.exception("DRY RUN failed: %s %s %s", entry.brand, entry.model, entry.part)
            finally:
                await page.close()
        await context.close()
        await browser.close()
    return 0


async def discover_all(
    brand: str,
    delay_seconds: float,
    max_models: int | None,
    samsung_series: str | None,
    oppo_series: str | None,
    realme_series: str | None,
    model_filter: str | None = None,
    db_path: Path | None = None,
    parallel: int = 4,
    cashify_city: str = DEFAULT_CASHIFY_CITY,
) -> int:
    from playwright.async_api import async_playwright

    conn = connect_db(db_path or default_db_path("price_history.sqlite3"))
    city_cookies = cashify_city_cookies(cashify_city)
    # Playwright (a node process) and the browser are started only when a
    # crawler needs them: Cashify runs through the site API and usually needs
    # neither, which keeps a Cashify-only run to a few tens of megabytes.
    launched: dict[str, Any] = {}
    launch_lock = asyncio.Lock()
    try:

        async def get_browser() -> Any:
            async with launch_lock:
                if "browser" not in launched:
                    launched["playwright"] = await async_playwright().start()
                    launched["browser"] = await launched["playwright"].chromium.launch(
                        headless=True, args=browser_launch_args()
                    )
                    launched["context"] = await new_crawl_context(launched["browser"])
                    await launched["context"].add_cookies(city_cookies)
            return launched["browser"]

        async def get_context() -> Any:
            await get_browser()
            return launched["context"]

        def with_context(crawler: Callable[..., Awaitable[None]], *args: Any) -> Callable[[], Awaitable[None]]:
            async def run() -> None:
                await crawler(await get_context(), *args)
            return run

        def with_browser(crawler: Callable[..., Awaitable[None]], *args: Any) -> Callable[[], Awaitable[None]]:
            async def run() -> None:
                await crawler(await get_browser(), *args)
            return run

        # Each brand crawler talks to a different website, so they run side by
        # side (up to `parallel` at once) without hitting any one site harder.
        jobs: list[tuple[str, Callable[[], Awaitable[None]]]] = []
        if brand in {"all", "apple"}:
            jobs.append(("Apple", with_context(discover_apple, conn, delay_seconds, max_models, model_filter)))
        if brand in {"all", "samsung"}:
            jobs.append(("Samsung", with_browser(discover_samsung, conn, delay_seconds, max_models, samsung_series, model_filter)))
        if brand in {"all", "oppo"}:
            jobs.append(("OPPO", with_browser(discover_oppo, conn, delay_seconds, max_models, oppo_series, model_filter)))
        if brand in {"all", "realme"}:
            jobs.append(("realme", with_browser(discover_realme, conn, delay_seconds, max_models, realme_series, model_filter)))
        if brand in {"all", "oneplus"}:
            jobs.append(("OnePlus", with_context(discover_oneplus, conn, delay_seconds, max_models, model_filter)))
        if brand in {"all", "mi"}:
            jobs.append(("Mi", with_context(discover_mi, conn, delay_seconds, max_models, model_filter)))
        if brand in {"all", "vivo"}:
            jobs.append(("vivo", with_context(discover_vivo, conn, delay_seconds, max_models, model_filter)))
        if brand in {"all", "iqoo"}:
            jobs.append(("iQOO", with_context(discover_iqoo, conn, delay_seconds, max_models, model_filter)))
        if brand in {"all", "motorola"}:
            jobs.append(("Motorola", with_context(discover_motorola, conn, delay_seconds, max_models, model_filter)))
        if brand in {"all", "cashify"}:
            jobs.append(("Cashify", lambda: discover_cashify(get_context, conn, delay_seconds, max_models, model_filter)))

        semaphore = asyncio.Semaphore(max(1, parallel))

        async def run_job(name: str, job: Callable[[], Awaitable[None]]) -> None:
            async with semaphore:
                LOGGER.info("Starting %s catalog discovery", name)
                try:
                    await job()
                except Exception:
                    LOGGER.exception("%s catalog discovery failed", name)
                LOGGER.info("Finished %s catalog discovery", name)

        LOGGER.info("Running %s catalog crawls, up to %s at a time", len(jobs), max(1, parallel))
        await asyncio.gather(*(run_job(name, job) for name, job in jobs))
    finally:
        if "context" in launched:
            await launched["context"].close()
            await launched["browser"].close()
        if "playwright" in launched:
            await launched["playwright"].stop()
    conn.close()
    flush_remote_store()
    return 0


def flush_remote_store() -> None:
    if REMOTE_STORE is None:
        return
    if REMOTE_STORE.flush():
        LOGGER.info("All rows were sent to %s", REMOTE_STORE.base_url)
    else:
        LOGGER.warning("%s rows are still waiting to be sent to %s", REMOTE_STORE.pending(), REMOTE_STORE.base_url)


def push_history(db_path: Path, batch_size: int, after_id: int) -> int:
    """Upload the local SQLite history to the remote store, oldest first."""
    if REMOTE_STORE is None:
        raise SystemExit("Set PRICE_API_URL and PRICE_API_KEY first (see hostinger_api/README.md).")
    if not REMOTE_STORE.health():
        raise SystemExit(f"{REMOTE_STORE.base_url}/health did not answer; check the URL and that the API is uploaded.")
    conn = connect_db(db_path)
    total = conn.execute("SELECT COUNT(*) FROM price_history WHERE id > ?", (after_id,)).fetchone()[0]
    LOGGER.info("Uploading %s rows from %s to %s", total, db_path, REMOTE_STORE.base_url)
    sent = inserted = 0
    last_id = after_id
    while True:
        rows = conn.execute(
            "SELECT id, date, brand, model, part, price, price_value, currency, url, status, error "
            "FROM price_history WHERE id > ? ORDER BY id LIMIT ?",
            (last_id, batch_size),
        ).fetchall()
        if not rows:
            break
        result = REMOTE_STORE.post_rows([dict(zip([c[0] for c in conn.execute("SELECT * FROM price_history LIMIT 0").description], row)) for row in rows])
        sent += len(rows)
        inserted += int(result.get("inserted") or 0)
        last_id = rows[-1][0]
        LOGGER.info("Uploaded %s/%s rows (%s new so far, last id %s)", sent, total, inserted, last_id)
    conn.close()
    status = REMOTE_STORE.status()
    LOGGER.info("Done. Remote store now holds %s rows (latest %s)", status.get("count"), status.get("max_date"))
    return 0


async def discover_apple(
    context: Any,
    conn: sqlite3.Connection,
    delay_seconds: float,
    max_models: int | None,
    model_filter: str | None = None,
) -> None:
    url = "https://support.apple.com/en-in/iphone/repair?services=service"
    page = await context.new_page()
    page.set_default_timeout(45000)
    count = 0
    try:
        await page.goto(url, wait_until="domcontentloaded")
        await page.wait_for_load_state("networkidle")
        device_labels = await page.locator("select.device-dropdown").first.evaluate(
            "select => [...select.options].map(option => option.textContent.trim()).filter(Boolean)"
        )
        for device_label in device_labels:
            await page.locator("select.device-dropdown").first.select_option(label=device_label)
            await page.wait_for_timeout(1500)
            model_labels = await page.locator("select.model-dropdown").first.evaluate(
                "select => [...select.options].map(option => option.textContent.trim()).filter(Boolean)"
            )
            for model_label in model_labels:
                if not model_matches_filter(model_label, model_filter):
                    continue
                if max_models is not None and count >= max_models:
                    return
                await page.locator("select.model-dropdown").first.select_option(label=model_label)
                await page.wait_for_timeout(1500)
                text = await page.locator("body").inner_text()
                price_rows = parse_apple_service_prices(text)
                for part, price_text, value in price_rows:
                    entry = TrackerEntry("Apple", model_label, part, url, "INR", [], "body")
                    save_result(
                        conn,
                        entry,
                        datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        price_text,
                        value,
                        "INR",
                        "ok",
                    )
                count += 1
                LOGGER.info("Discovered Apple %s (%s rows, %s/%s)", model_label, len(price_rows), count, max_models or "all")
                await asyncio.sleep(delay_seconds)
    except Exception:
        LOGGER.exception("Apple catalog discovery failed")
    finally:
        await page.close()


async def discover_samsung(
    browser: Any,
    conn: sqlite3.Connection,
    delay_seconds: float,
    max_models: int | None,
    samsung_series: str | None = None,
    model_filter: str | None = None,
) -> None:
    url = "https://www.samsung.com/in/support/spare-part-pricing-list-for-repair/"
    series_values = [
        ("galaxy-z", "Galaxy Z Series"),
        ("galaxy-s", "Galaxy S Series"),
        ("galaxy-a", "Galaxy A Series"),
        ("galaxy-m", "Galaxy M Series"),
        ("galaxy-f", "Galaxy F Series"),
        ("galaxy-tab", "Galaxy Tab Series"),
    ]
    if samsung_series:
        series_values = [item for item in series_values if item[0] == samsung_series]
    count = 0
    for series_value, series_label in series_values:
        context = await new_crawl_context(browser)
        page = await context.new_page()
        page.set_default_timeout(45000)
        try:
            await page.goto(url, wait_until="domcontentloaded")
            try:
                await page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                LOGGER.info("Continuing after Samsung networkidle timeout for %s", series_value)
            try:
                await page.evaluate("() => { localStorage.clear(); sessionStorage.clear(); }")
                await page.reload(wait_until="domcontentloaded")
                try:
                    await page.wait_for_load_state("networkidle", timeout=15000)
                except Exception:
                    LOGGER.info("Continuing after Samsung reload networkidle timeout for %s", series_value)
            except Exception:
                pass
            try:
                await page.get_by_text("Accept", exact=True).first.click(timeout=2000)
            except Exception:
                pass
            model_values = await load_samsung_models_for_series(page, series_value, series_label)
            LOGGER.info("Samsung %s models found: %s", series_value, len(model_values))
            if not model_values:
                continue
            seen_models: set[str] = set()
            for model_value in model_values:
                if not model_matches_filter(model_value, model_filter):
                    continue
                if model_value in seen_models:
                    continue
                seen_models.add(model_value)
                if max_models is not None and count >= max_models:
                    return
                try:
                    await page.locator(f'input[name="models"][value="{css_escape(model_value)}"]').click(force=True)
                    await page.wait_for_timeout(1600)
                    rows = await page.locator(".smartphone-detail-result-tr").evaluate_all(
                        """
                        trs => trs.flatMap(tr => {
                          const rows = [...tr.querySelectorAll('.smartphone-detail-result-row')];
                          return rows.map(row => {
                            const title = row.querySelector('.result-title')?.innerText?.trim();
                            const price = row.querySelector('.result-price')?.innerText?.trim();
                            return title && price ? { title, price } : null;
                          }).filter(Boolean);
                        })
                        """
                    )
                    for row in rows:
                        part, price_text, value = parse_samsung_row(row["title"], row["price"])
                        entry = TrackerEntry("Samsung", model_value, part, url, "INR", [], "body")
                        save_result(
                            conn,
                            entry,
                            datetime.now(timezone.utc).isoformat(timespec="seconds"),
                            price_text,
                            value,
                            "INR",
                            "ok",
                        )
                    count += 1
                    LOGGER.info("Discovered Samsung %s (%s rows, %s/%s)", model_value, len(rows), count, max_models or "all")
                    await asyncio.sleep(delay_seconds)
                except Exception:
                    LOGGER.exception("Samsung model discovery failed: %s", model_value)
        except Exception:
            LOGGER.exception("Samsung catalog discovery failed for series: %s", series_value)
        finally:
            await page.close()
            await context.close()


def parse_samsung_row(title: str, price: str) -> tuple[str, str, float | None]:
    part = normalize_space(title.replace("\u2022", "-"))
    # FRAGILE SITE ASSUMPTION: Samsung's storage-only rows are motherboard
    # variants. The amount must come only from .result-price, never the title.
    storage = re.fullmatch(r"-?\s*(\d+\s*(?:GB|TB))", part, re.IGNORECASE)
    if storage:
        part = f"Motherboard - {storage.group(1).upper()}"
    amount = normalize_space(price)
    if re.search(r"\d\s*(?:GB|TB)", amount, re.IGNORECASE):
        raise ValueError(f"Storage label found in Samsung price cell: {amount!r}")
    _, value = parse_price(amount)
    return part, f"{part} {amount}", value


async def load_samsung_models_for_series(page: Any, series_value: str, series_label: str) -> list[str]:
    # FRAGILE SITE ASSUMPTION: Samsung uses a custom dropdown where the visible
    # cards and hidden radio inputs must be in the right open/closed state.
    for attempt in range(2):
        try:
            await page.locator("a.select-series").click(timeout=5000)
        except Exception:
            pass
        try:
            label = page.locator(".choose-smartphone-name").filter(has_text=series_label).first
            await label.scroll_into_view_if_needed(timeout=3000)
            box = await label.bounding_box()
            if box:
                await page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            else:
                await page.locator(f'input[name="series"][value="{series_value}"]').click(force=True)
            await page.wait_for_timeout(1200)
            model_values = await page.locator('input[name="models"]').evaluate_all(
                "inputs => inputs.map(input => input.value).filter(Boolean)"
            )
            if not model_values:
                await page.reload(wait_until="domcontentloaded")
                try:
                    await page.wait_for_load_state("networkidle", timeout=15000)
                except Exception:
                    pass
                continue
            return model_values
        except Exception:
            if attempt == 1:
                LOGGER.exception("Samsung series selection failed: %s", series_value)
            else:
                await page.reload(wait_until="domcontentloaded")
                try:
                    await page.wait_for_load_state("networkidle", timeout=15000)
                except Exception:
                    pass
    return []


async def discover_oppo(
    browser: Any,
    conn: sqlite3.Connection,
    delay_seconds: float,
    max_models: int | None,
    oppo_series: str | None = None,
    model_filter: str | None = None,
) -> None:
    url = "https://support.oppo.com/in/spare-parts-price/#/"
    series_labels = OPPO_MOBILE_SERIES
    if oppo_series:
        series_labels = [label for label in series_labels if label == oppo_series]
    count = 0
    context = await new_crawl_context(browser)
    page = await context.new_page()
    page.set_default_timeout(30000)
    try:
        await goto_catalog_page(page, url)
        available_series = set(await visible_texts(page, "li.sidebar-item"))
        for series_label in series_labels:
            if series_label not in available_series:
                LOGGER.warning("OPPO series not found on page: %s", series_label)
                continue
            try:
                await open_oppo_series(page, url, series_label)
                product_names = await visible_texts(page, ".product-item")
                product_names = [name for name in product_names if model_matches_filter(name, model_filter)]
                LOGGER.info("OPPO %s models found: %s", series_label, len(product_names))
            except Exception:
                LOGGER.exception("OPPO series discovery failed: %s", series_label)
                continue

            for model_name in product_names:
                if max_models is not None and count >= max_models:
                    return
                try:
                    await open_oppo_series(page, url, series_label)
                    await click_visible_text(page, ".product-item", model_name)
                    await page.wait_for_timeout(1800)
                    raw_rows = await page.locator(".small-item").evaluate_all(
                        "items => items.map(item => item.innerText.trim()).filter(Boolean)"
                    )
                    saved = save_catalog_rows(conn, "OPPO", model_name, url, raw_rows)
                    if not saved:
                        raise ValueError("No OPPO spare-part price rows found after selecting model")
                    count += 1
                    LOGGER.info("Discovered OPPO %s (%s rows, %s/%s)", model_name, saved, count, max_models or "all")
                    await asyncio.sleep(delay_seconds)
                except Exception as exc:
                    LOGGER.exception("OPPO model discovery failed: %s", model_name)
                    save_catalog_error(conn, "OPPO", model_name, url, f"{type(exc).__name__}: {exc}")
    finally:
        await page.close()
        await context.close()


async def discover_realme(
    browser: Any,
    conn: sqlite3.Connection,
    delay_seconds: float,
    max_models: int | None,
    realme_series: str | None = None,
    model_filter: str | None = None,
) -> None:
    url = "https://www.realme.com/in/support/spare-parts-price"
    series_labels = REALME_MOBILE_SERIES
    if realme_series:
        series_labels = [label for label in series_labels if label == realme_series]
    count = 0
    context = await new_crawl_context(browser)
    page = await context.new_page()
    page.set_default_timeout(30000)
    try:
        await goto_catalog_page(page, url)
        for series_label in series_labels:
            try:
                await open_realme_series(page, url, series_label)
                product_names = await visible_texts(page, ".main-right .item")
                product_names = [name for name in product_names if model_matches_filter(name, model_filter)]
                LOGGER.info("realme %s models found: %s", series_label, len(product_names))
            except Exception:
                LOGGER.exception("realme series discovery failed: %s", series_label)
                continue

            for model_name in product_names:
                if max_models is not None and count >= max_models:
                    return
                try:
                    await open_realme_series(page, url, series_label)
                    await click_visible_text(page, ".main-right .item", model_name)
                    await page.wait_for_timeout(2200)
                    raw_rows = await page.locator(".spare-parts-price .result-collapse .item").evaluate_all(
                        "items => items.map(item => item.innerText.trim()).filter(Boolean)"
                    )
                    saved = save_catalog_rows(conn, "realme", model_name, url, raw_rows)
                    if not saved:
                        raise ValueError("No realme spare-part price rows found after selecting model")
                    count += 1
                    LOGGER.info("Discovered realme %s (%s rows, %s/%s)", model_name, saved, count, max_models or "all")
                    await asyncio.sleep(delay_seconds)
                except Exception as exc:
                    LOGGER.exception("realme model discovery failed: %s", model_name)
                    save_catalog_error(conn, "realme", model_name, url, f"{type(exc).__name__}: {exc}")
    finally:
        await page.close()
        await context.close()


async def discover_oneplus(
    context: Any,
    conn: sqlite3.Connection,
    delay_seconds: float,
    max_models: int | None,
    model_filter: str | None = None,
) -> None:
    # FRAGILE SITE ASSUMPTION: OnePlus India currently powers the public page
    # with these OPPO/OnePlus CMS endpoints and marketingModelCode identifiers.
    request = context.request
    count = 0
    try:
        product_payload = await api_post_json(
            request,
            f"{ONEPLUS_API_BASE}/basic/v1/getProduct",
            {"regionIsoCode2": "IN"},
            headers=oneplus_headers(),
        )
        products = [
            item
            for item in product_payload.get("data", [])
            if str(item.get("categoryCode")) == "01"
            and model_matches_filter(str(item.get("marketingModelName") or ""), model_filter)
        ]
        LOGGER.info("OnePlus mobile models found: %s", len(products))
        for item in products:
            if max_models is not None and count >= max_models:
                return
            model_name = str(item.get("marketingModelName") or "").strip()
            model_code = str(item.get("marketingModelCode") or "").strip()
            if not model_name or not model_code:
                continue
            try:
                price_payload = await api_post_json(
                    request,
                    f"{ONEPLUS_API_BASE}/basic/v1/getPartPriceNew",
                    {"marketingModelCode": model_code, "regionIsoCode2": "IN"},
                    headers=oneplus_headers(),
                )
                rows = oneplus_price_rows(price_payload)
                saved = save_structured_price_rows(conn, "OnePlus", model_name, ONEPLUS_SUPPORT_URL, rows)
                if not saved:
                    raise ValueError("No OnePlus spare-part price rows returned")
                count += 1
                LOGGER.info("Discovered OnePlus %s (%s rows, %s/%s)", model_name, saved, count, max_models or "all")
                await asyncio.sleep(delay_seconds)
            except Exception as exc:
                LOGGER.exception("OnePlus model discovery failed: %s", model_name)
                save_catalog_error(conn, "OnePlus", model_name, ONEPLUS_SUPPORT_URL, f"{type(exc).__name__}: {exc}")
    except Exception:
        LOGGER.exception("OnePlus catalog discovery failed")


async def discover_mi(
    context: Any,
    conn: sqlite3.Connection,
    delay_seconds: float,
    max_models: int | None,
    model_filter: str | None = None,
) -> None:
    # FRAGILE SITE ASSUMPTION: Xiaomi India currently serves model and part data
    # from in-go.buy.mi.com with the public Basic auth value embedded in the page bundle.
    request = context.request
    count = 0
    try:
        models = await api_get_json(
            request,
            f"{MI_API_BASE}/spare-part/category/models/Mobile",
            headers=mi_headers(),
        )
        model_names = [
            str(model).strip()
            for model in models
            if str(model).strip() and model_matches_filter(str(model), model_filter)
        ]
        LOGGER.info("Mi mobile models found: %s", len(model_names))
        for model_name in model_names:
            if max_models is not None and count >= max_models:
                return
            try:
                rows = await fetch_mi_model_rows(request, model_name)
                saved = save_structured_price_rows(conn, "Mi", model_name, MI_SUPPORT_URL, rows)
                if not saved:
                    raise ValueError("No Mi spare-part price rows returned")
                count += 1
                LOGGER.info("Discovered Mi %s (%s rows, %s/%s)", model_name, saved, count, max_models or "all")
                await asyncio.sleep(delay_seconds)
            except Exception as exc:
                LOGGER.exception("Mi model discovery failed: %s", model_name)
                save_catalog_error(conn, "Mi", model_name, MI_SUPPORT_URL, f"{type(exc).__name__}: {exc}")
    except Exception:
        LOGGER.exception("Mi catalog discovery failed")


async def discover_vivo(
    context: Any,
    conn: sqlite3.Connection,
    delay_seconds: float,
    max_models: int | None,
    model_filter: str | None = None,
) -> None:
    # FRAGILE SITE ASSUMPTION: vivo India renders model ids into .select-model-item
    # and posts the selected id to /in/support/queryPriceByProductId.
    page = await context.new_page()
    page.set_default_timeout(30000)
    count = 0
    try:
        await goto_catalog_page(page, VIVO_SUPPORT_URL)
        models = await page.locator(".select-model-item").evaluate_all(
            """
            items => items.map(item => ({
              id: item.getAttribute('data-id'),
              name: item.innerText.trim()
            })).filter(item => item.id && item.name)
            """
        )
        models = [
            item
            for item in models
            if model_matches_filter(str(item.get("name") or ""), model_filter)
        ]
        LOGGER.info("vivo mobile models found: %s", len(models))
        for item in models:
            if max_models is not None and count >= max_models:
                return
            model_name = str(item.get("name") or "").strip()
            model_id = str(item.get("id") or "").strip()
            try:
                payload = await api_post_json(
                    context.request,
                    "https://www.vivo.com/in/support/queryPriceByProductId",
                    None,
                    headers={"Referer": VIVO_SUPPORT_URL, "Origin": "https://www.vivo.com"},
                    form={"id": model_id},
                )
                rows = vivo_price_rows(payload)
                saved = save_structured_price_rows(conn, "vivo", model_name, VIVO_SUPPORT_URL, rows)
                if not saved:
                    raise ValueError("No vivo spare-part price rows returned")
                count += 1
                LOGGER.info("Discovered vivo %s (%s rows, %s/%s)", model_name, saved, count, max_models or "all")
                await asyncio.sleep(delay_seconds)
            except Exception as exc:
                LOGGER.exception("vivo model discovery failed: %s", model_name)
                save_catalog_error(conn, "vivo", model_name, VIVO_SUPPORT_URL, f"{type(exc).__name__}: {exc}")
    except Exception:
        LOGGER.exception("vivo catalog discovery failed")
    finally:
        await page.close()


async def discover_iqoo(
    context: Any,
    conn: sqlite3.Connection,
    delay_seconds: float,
    max_models: int | None,
    model_filter: str | None = None,
) -> None:
    # FRAGILE SITE ASSUMPTION: iQOO currently exposes model IDs in
    # .select-model-item and loads prices after clicking a model in its picker.
    page = await context.new_page()
    page.set_default_timeout(30000)
    count = 0
    try:
        await goto_catalog_page(page, IQOO_SUPPORT_URL)
        models = await page.locator(".select-model-item").evaluate_all(
            """
            items => items.map(item => ({
              id: item.getAttribute('data-id'),
              name: item.innerText.trim()
            })).filter(item => item.id && item.name)
            """
        )
        models = [item for item in models if model_matches_filter(str(item.get("name") or ""), model_filter)]
        LOGGER.info("iQOO mobile models found: %s", len(models))
        for item in models:
            if max_models is not None and count >= max_models:
                return
            model_name = str(item.get("name") or "").strip()
            model_id = str(item.get("id") or "").strip()
            try:
                await page.locator("#boxSelectModel").click()
                model = page.locator(f'.select-model-item[data-id="{css_escape(model_id)}"]').first
                async with page.expect_response(lambda response: "queryPriceByProductId" in response.url) as response_info:
                    await model.click()
                payload = await (await response_info.value).json()
                rows = vivo_price_rows(payload)
                saved = save_structured_price_rows(conn, "iQOO", model_name, IQOO_SUPPORT_URL, rows)
                if not saved:
                    raise ValueError("No iQOO spare-part price rows returned")
                count += 1
                LOGGER.info("Discovered iQOO %s (%s rows, %s/%s)", model_name, saved, count, max_models or "all")
                await asyncio.sleep(delay_seconds)
            except Exception as exc:
                LOGGER.exception("iQOO model discovery failed: %s", model_name)
                save_catalog_error(conn, "iQOO", model_name, IQOO_SUPPORT_URL, f"{type(exc).__name__}: {exc}")
    except Exception:
        LOGGER.exception("iQOO catalog discovery failed")
    finally:
        await page.close()


async def discover_motorola(
    context: Any,
    conn: sqlite3.Connection,
    delay_seconds: float,
    max_models: int | None,
    model_filter: str | None = None,
) -> None:
    # FRAGILE SITE ASSUMPTION: Motorola's India page currently renders each
    # model as an XT code heading, followed by "Part: price" text lines.
    page = await context.new_page()
    page.set_default_timeout(30000)
    try:
        await goto_catalog_page(page, MOTOROLA_SUPPORT_URL)
        catalog = motorola_price_rows(await page.locator("body").inner_text())
        models = [model for model in catalog if model_matches_filter(model, model_filter)]
        LOGGER.info("Motorola mobile models found: %s", len(models))
        for count, model_name in enumerate(models, start=1):
            if max_models is not None and count > max_models:
                return
            saved = save_structured_price_rows(conn, "Motorola", model_name, MOTOROLA_SUPPORT_URL, catalog[model_name])
            if not saved:
                save_catalog_error(conn, "Motorola", model_name, MOTOROLA_SUPPORT_URL, "No Motorola spare-part price rows found")
                continue
            LOGGER.info("Discovered Motorola %s (%s rows, %s/%s)", model_name, saved, count, max_models or "all")
            if count < len(models):
                await asyncio.sleep(delay_seconds)
    except Exception:
        LOGGER.exception("Motorola catalog discovery failed")
    finally:
        await page.close()


CASHIFY_API = "https://www.cashify.in/api"
CASHIFY_SERVICE_ACRONYMS = {"LCD", "OLED", "AMOLED", "USB", "SIM", "5G", "4G", "IMEI"}
CASHIFY_SERVICE_RENAMES = {"motherboard inspection charges": "Motherboard Inspection"}


def cashify_service_name(raw: str) -> str:
    """"CHARGING JACK" -> "Charging Jack", matching how the site shows it."""
    cleaned = normalize_space(raw or "")
    renamed = CASHIFY_SERVICE_RENAMES.get(cleaned.lower())
    if renamed:
        return renamed
    words = []
    for word in cleaned.split(" "):
        bare = word.strip("()")
        if bare.upper() in CASHIFY_SERVICE_ACRONYMS:
            words.append(word.upper())
            continue
        index = next((i for i, ch in enumerate(word) if ch.isalpha()), None)
        words.append(word if index is None else word[:index] + word[index].upper() + word[index + 1:].lower())
    return " ".join(words)


CASHIFY_TOKEN_FILE = Path(__file__).with_name(".cashify_token.json")
CASHIFY_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"


def _http_json(method: str, url: str, body: dict[str, Any] | None, headers: dict[str, str]) -> Any:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={"user-agent": CASHIFY_USER_AGENT, **headers})
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise PermissionError("Cashify API token was rejected") from exc
        raise ValueError(f"{method} {url} failed with HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:200]}") from exc


async def cashify_api_post(path: str, body: dict[str, Any], token: str | None) -> Any:
    """Plain HTTP call to Cashify's JSON API, off the event loop thread."""
    headers = {"content-type": "application/json", "accept": "application/json", "x-app-installer": "cashify"}
    if token:
        headers["x-authorization"] = token
    return await asyncio.to_thread(_http_json, "POST", f"{CASHIFY_API}/{path}", body, headers)


def cashify_token_expiry(token: str) -> float:
    """Unix time the bearer token expires, or 0 if it cannot be read."""
    try:
        payload = token.replace("Bearer ", "").split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return float(json.loads(base64.urlsafe_b64decode(payload)).get("exp") or 0)
    except Exception:
        return 0.0


def load_cached_cashify_token() -> str | None:
    try:
        saved = json.loads(CASHIFY_TOKEN_FILE.read_text(encoding="utf-8"))
        token = str(saved.get("token") or "")
    except Exception:
        return None
    if token and cashify_token_expiry(token) - time.time() > 600:
        return token
    return None


def save_cached_cashify_token(token: str) -> None:
    try:
        CASHIFY_TOKEN_FILE.write_text(json.dumps({"token": token, "exp": cashify_token_expiry(token)}), encoding="utf-8")
    except OSError:
        LOGGER.debug("Could not cache the Cashify token", exc_info=True)


async def cashify_capture_token(get_context: Callable[[], Awaitable[Any]]) -> str | None:
    """Load one Cashify page in the browser and take the bearer token its own
    scripts send. Cached to disk so most runs need no browser at all."""
    context = await get_context()
    page = await context.new_page()
    token: dict[str, str] = {}

    def on_request(request: Any) -> None:
        value = request.headers.get("x-authorization")
        if value and "/api/" in request.url:
            token.setdefault("value", value)

    page.on("request", on_request)
    try:
        await goto_catalog_page(page, CASHIFY_REPAIR_URL)
        for _ in range(10):
            if token:
                break
            await page.wait_for_timeout(500)
    finally:
        await page.close()
    if token.get("value"):
        save_cached_cashify_token(token["value"])
        expires = cashify_token_expiry(token["value"])
        if expires:
            LOGGER.info("Cashify API token captured, valid for %.0f hours", max(0.0, expires - time.time()) / 3600)
    return token.get("value")


def cashify_brand_urls_from_html() -> list[str]:
    """Brand pages linked from the repair landing page, read from plain HTML."""
    request = urllib.request.Request(CASHIFY_REPAIR_URL, headers={"user-agent": CASHIFY_USER_AGENT})
    with urllib.request.urlopen(request, timeout=45) as response:
        html = response.read().decode("utf-8", "replace")
    slugs = sorted(set(re.findall(r'href="/repair/([a-z0-9-]+)"', html)))
    return [f"https://www.cashify.in/repair/{slug}" for slug in slugs]


async def cashify_list_models(seo: str, token: str) -> list[dict[str, Any]]:
    """Every model on a Cashify brand page, including the ones behind the
    series tabs, with the ids needed to price them."""
    models: list[dict[str, Any]] = []
    offset = 0
    while True:
        body = {
            "serid": 1, "souid": 1, "plid": 20, "bid": None, "pcid": None, "ps": 500, "os": offset,
            "pin": ACTIVE_CASHIFY_CITY["dp"], "regid": ACTIVE_CASHIFY_CITY["ri"], "fid": None, "pid": None, "seo": seo,
        }
        data = await cashify_api_post(f"pd01/v1/product-search-template?key=sp_parent_product&seo={quote(seo, safe='')}", body, token)
        items = data.get("dt") or []
        image_base = str(data.get("piu") or "")
        for item in items:
            colours = ((item.get("specs") or {}).get("color")) or []
            first = colours[0] if colours and isinstance(colours[0], dict) else {}
            if not item.get("pi") or not item.get("bid") or not first.get("id"):
                continue
            models.append({
                "bid": item["bid"], "bn": item.get("bn") or "", "pid": item["pi"], "plid": item.get("pli") or 20,
                "pn": normalize_space(str(item.get("pn") or "")), "pcid": first["id"], "pcn": first.get("dval") or "",
                "cdn": image_base, "in": item.get("pin") or "",
            })
        offset += len(items)
        if not items or offset >= int(data.get("hits") or 0):
            return models


async def cashify_model_prices(entry: dict[str, Any], token: str | None) -> list[dict[str, Any]]:
    body = {
        "plid": entry["plid"], "bid": entry["bid"], "pid": entry["pid"], "pcid": entry["pcid"],
        "ri": ACTIVE_CASHIFY_CITY["ri"], "pin": ACTIVE_CASHIFY_CITY["dp"],
    }
    data = await cashify_api_post("sp01/v3/services-available", body, token)
    rows = []
    for item in data.get("dt") or []:
        name = cashify_service_name(str(item.get("stn") or ""))
        price = coerce_price_value(item.get("cp"))
        if name and price is not None:
            rows.append({"part": f"Cashify - {name}", "price_value": price, "currency": "INR"})
    return rows


def cashify_brands_for_filter(brand_urls: list[str], model_filter: str | None) -> list[str]:
    """Only the brand pages a model filter can match ("iPhone 17e" -> Apple)."""
    if not model_filter:
        return brand_urls
    requested = model_filter.lower()
    wanted = {cashify_brand_name(str(url)).lower() for url in brand_urls if cashify_brand_name(str(url)).lower() in requested}
    for keyword, hinted in CASHIFY_MODEL_BRAND_HINTS.items():
        if keyword in requested:
            wanted.add(hinted)
    matching = [url for url in brand_urls if cashify_brand_name(str(url)).lower() in wanted]
    if matching:
        LOGGER.info("Cashify brands matching %r: %s", model_filter, ", ".join(sorted(wanted)))
    return matching or brand_urls


async def discover_cashify(
    get_context: Callable[[], Awaitable[Any]],
    conn: sqlite3.Connection,
    delay_seconds: float,
    max_models: int | None,
    model_filter: str | None = None,
) -> None:
    """Cashify prices through the site's own JSON API.

    Every model list and price is a small JSON call, so no browser page is
    rendered per model: a full Cashify crawl takes a few minutes and a few
    tens of megabytes. The only thing that needs a browser is the bearer
    token the site's scripts send, captured from one page load and cached
    on disk until it expires. Falls back to driving the pages if the API
    changes.
    """
    token = load_cached_cashify_token()
    if token:
        LOGGER.info("Using the cached Cashify API token")
    else:
        try:
            token = await cashify_capture_token(get_context)
        except Exception:
            LOGGER.exception("Could not load Cashify to capture its API token")
            token = None
    if not token:
        LOGGER.warning("Cashify API token not found; falling back to page-driven discovery")
        await discover_cashify_browser(await get_context(), conn, delay_seconds, max_models, model_filter)
        return
    LOGGER.info("Cashify prices are being read for pincode %s via the site API", ACTIVE_CASHIFY_CITY["dp"])
    try:
        brand_urls = await asyncio.to_thread(cashify_brand_urls_from_html)
    except Exception:
        LOGGER.exception("Could not read Cashify's brand list")
        brand_urls = []
    brand_urls = cashify_brands_for_filter(brand_urls, model_filter)
    LOGGER.info("Cashify repair brands found: %s", len(brand_urls))
    count = 0
    for brand_url in brand_urls:
        cashify_brand = cashify_brand_name(brand_url)
        exact_brand_filter = bool(model_filter and model_filter.strip().lower() == cashify_brand.lower())
        seo = "/repair/" + brand_url.rstrip("/").rsplit("/", 1)[-1]
        try:
            models = await cashify_list_models(seo, token)
        except PermissionError:
            LOGGER.info("Cashify API token was rejected; capturing a fresh one")
            token = await cashify_capture_token(get_context)
            if not token:
                LOGGER.warning("Cashify API token expired and could not be renewed; stopping")
                return
            models = await cashify_list_models(seo, token)
        except Exception as exc:
            LOGGER.exception("Cashify model list failed for %s", cashify_brand)
            save_catalog_error(conn, cashify_brand, f"Cashify {cashify_brand}", brand_url, f"{type(exc).__name__}: {exc}")
            continue
        LOGGER.info("Cashify %s mobile models found: %s", cashify_brand, len(models))
        for entry in models:
            model_name = entry["pn"]
            if not model_name or (not exact_brand_filter and not model_matches_filter(model_name, model_filter)):
                continue
            if max_models is not None and count >= max_models:
                return
            quote_url = cashify_quote_url(entry)
            try:
                rows = await cashify_model_prices(entry, token)
                saved = save_structured_price_rows(conn, cashify_brand, model_name, quote_url, rows)
                if not saved:
                    LOGGER.info("Cashify has no published repair-service prices for %s", model_name)
                    continue
                count += 1
                LOGGER.info("Discovered Cashify %s %s (%s rows, %s/%s)", cashify_brand, model_name, saved, count, max_models or "all")
                await asyncio.sleep(delay_seconds)
            except Exception as exc:
                LOGGER.exception("Cashify model discovery failed: %s", model_name)
                save_catalog_error(conn, cashify_brand, f"Cashify {model_name}", quote_url, f"{type(exc).__name__}: {exc}")


async def discover_cashify_browser(
    context: Any,
    conn: sqlite3.Connection,
    delay_seconds: float,
    max_models: int | None,
    model_filter: str | None = None,
) -> None:
    # FRAGILE SITE ASSUMPTION: Cashify currently exposes repair brand/model
    # pages as /repair/<brand>/<model>, then shows service prices after a colour
    # card is selected. The first available colour is used as the reference.
    page = await context.new_page()
    page.set_default_timeout(45000)
    count = 0
    try:
        await goto_catalog_page(page, CASHIFY_REPAIR_URL)
        pincode = await page.evaluate("() => (document.cookie.match(/_cs__pc__v1=(\\d+)/) || [])[1] || ''")
        LOGGER.info("Cashify prices are being read for pincode %s", pincode or "unknown")
        brand_urls = await page.locator('a[href*="/repair/"]').evaluate_all(
            r"""
            anchors => [...new Set(anchors.map(anchor => anchor.href))]
              .filter(href => /^https:\/\/www\.cashify\.in\/repair\/[^/?#]+\/?$/.test(href))
            """
        )
        if model_filter:
            requested = model_filter.lower()
            wanted_brands = {cashify_brand_name(str(url)).lower() for url in brand_urls if cashify_brand_name(str(url)).lower() in requested}
            # A model name usually implies its brand ("iPhone 17e" -> Apple), so
            # only that brand page is visited instead of all sixteen.
            for keyword, hinted in CASHIFY_MODEL_BRAND_HINTS.items():
                if keyword in requested:
                    wanted_brands.add(hinted)
            matching_brands = [url for url in brand_urls if cashify_brand_name(str(url)).lower() in wanted_brands]
            if matching_brands:
                LOGGER.info("Cashify brands matching %r: %s", model_filter, ", ".join(sorted(wanted_brands)))
                brand_urls = matching_brands
        LOGGER.info("Cashify repair brands found: %s", len(brand_urls))
        for brand_index, brand_url in enumerate(brand_urls):
            if brand_index:
                # A fresh page per brand keeps renderer memory from creeping up
                # over a long crawl.
                await page.close()
                page = await context.new_page()
                page.set_default_timeout(45000)
            cashify_brand = cashify_brand_name(str(brand_url))
            exact_brand_filter = bool(model_filter and model_filter.strip().lower() == cashify_brand.lower())
            # FRAGILE SITE ASSUMPTION: the brand page first shows only a
            # "popular" subset of models. The rest sit behind series tabs
            # ("Galaxy Fold Series", "Galaxy S Series", ...) that swap the grid.
            # Each grid load also fetches a JSON catalog (product-search-template)
            # carrying the ids needed to open a model's quote page directly, so
            # those responses are captured while the tabs are visited.
            catalog: dict[str, dict[str, Any]] = {}
            pending: list[Any] = []

            def capture_catalog(response: Any) -> None:
                if "product-search-template" in response.url and response.ok:
                    pending.append(asyncio.ensure_future(collect_cashify_catalog(response, catalog)))

            page.on("response", capture_catalog)
            try:
                await goto_catalog_page(page, str(brand_url))
                series_labels = await cashify_series_labels(page)
                model_series: dict[str, str | None] = {}
                for series_label in [None, *series_labels]:
                    if series_label is not None:
                        await goto_catalog_page(page, str(brand_url))
                        if not await select_cashify_series(page, series_label):
                            LOGGER.warning("Cashify %s series tab was not found: %s", cashify_brand, series_label)
                            continue
                    await load_all_cashify_model_cards(page)
                    for raw_model_name in await cashify_model_card_names(page):
                        model_series.setdefault(raw_model_name, series_label)
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)
            finally:
                page.remove_listener("response", capture_catalog)
            for catalog_name in catalog:
                model_series.setdefault(catalog_name, None)
            LOGGER.info(
                "Cashify %s mobile models found: %s across %s series (%s with direct quote links)",
                cashify_brand, len(model_series), len(series_labels), len(catalog),
            )
            for raw_model_name, series_label in model_series.items():
                model_name = normalize_space(str(raw_model_name or ""))
                if not model_name or (not exact_brand_filter and not model_matches_filter(model_name, model_filter)):
                    continue
                if max_models is not None and count >= max_models:
                    return
                try:
                    entry = catalog.get(model_name)
                    if entry is not None:
                        # Fast path: open the quote page straight away.
                        await page.goto(cashify_quote_url(entry), wait_until="domcontentloaded", timeout=60000)
                    else:
                        # Fallback: reproduce the click flow through the brand page.
                        await goto_catalog_page(page, str(brand_url))
                        if series_label is not None and not await select_cashify_series(page, series_label):
                            raise ValueError(f"Cashify series tab was not found: {series_label}")
                        await load_all_cashify_model_cards(page)
                        card = page.locator(
                            f'.cursor-pointer img[src*="/product/"][alt="{css_escape(model_name)}"]'
                        ).first
                        if not await card.count():
                            raise ValueError("Cashify model card was not found after loading the brand page")
                        await card.click()
                        await page.wait_for_url("**/repair/user/order/quote?**", timeout=15000)
                    await page.get_by_role("heading", name="Pick Your Repair Service", exact=True).wait_for(
                        state="visible", timeout=20000
                    )
                    rows = [
                        {**row, "part": f"Cashify - {row['part']}"}
                        for row in cashify_price_rows(await page.locator("body").inner_text())
                    ]
                    saved = save_structured_price_rows(conn, cashify_brand, model_name, page.url, rows)
                    if not saved:
                        LOGGER.info("Cashify has no published repair-service prices for %s", model_name)
                        continue
                    count += 1
                    LOGGER.info("Discovered Cashify %s %s (%s rows, %s/%s)", cashify_brand, model_name, saved, count, max_models or "all")
                    await asyncio.sleep(delay_seconds)
                except Exception as exc:
                    LOGGER.exception("Cashify model discovery failed: %s", model_name)
                    save_catalog_error(conn, cashify_brand, f"Cashify {model_name}", str(brand_url), f"{type(exc).__name__}: {exc}")
    except Exception:
        LOGGER.exception("Cashify catalog discovery failed")
    finally:
        await page.close()


ACTIVE_CASHIFY_CITY: dict[str, Any] = dict(CASHIFY_CITIES[DEFAULT_CASHIFY_CITY])


def cashify_city_cookies(city: str) -> list[dict[str, Any]]:
    """Cookies that make Cashify quote prices for the requested city."""
    key = normalize_space(city or "").lower()
    if key not in CASHIFY_CITIES:
        raise SystemExit(f"Unknown Cashify city {city!r}; choose from: {', '.join(sorted(CASHIFY_CITIES))}")
    info = CASHIFY_CITIES[key]
    ACTIVE_CASHIFY_CITY.clear()
    ACTIVE_CASHIFY_CITY.update(info)
    city_info = {
        "ri": info["ri"], "rn": info["rn"], "dp": info["dp"], "isp": "1", "xmd": 1, "cs": [1],
        "pt": ["csh"], "rcy": 1, "seo": info["seo"], "id": False,
    }
    common = {"domain": ".cashify.in", "path": "/", "secure": True, "sameSite": "Lax"}
    return [
        {"name": "_cs__city-info__v1", "value": quote(json.dumps(city_info, separators=(",", ":")), safe=""), **common},
        {"name": "_cs__pc__v1", "value": str(info["dp"]), **common},
    ]


async def collect_cashify_catalog(response: Any, catalog: dict[str, dict[str, Any]]) -> None:
    """Record the ids Cashify's model grid JSON carries for each model."""
    try:
        data = await response.json()
    except Exception:
        return
    if not isinstance(data, dict):
        return
    image_base = str(data.get("piu") or "")
    for item in data.get("dt") or []:
        if not isinstance(item, dict):
            continue
        name = normalize_space(str(item.get("pn") or ""))
        if not name or not item.get("pi") or not item.get("bid"):
            continue
        colours = ((item.get("specs") or {}).get("color")) or []
        first_colour = colours[0] if colours and isinstance(colours[0], dict) else {}
        if not first_colour.get("id"):
            continue
        catalog.setdefault(
            name,
            {
                "bid": item["bid"],
                "bn": item.get("bn") or "",
                "pid": item["pi"],
                "plid": item.get("pli") or 20,
                "pn": name,
                "pcid": first_colour["id"],
                "pcn": first_colour.get("dval") or "",
                "cdn": image_base,
                "in": item.get("pin") or "",
            },
        )


def cashify_quote_url(entry: dict[str, Any]) -> str:
    # FRAGILE SITE ASSUMPTION: this is the URL Cashify itself navigates to when
    # a model card is clicked and the first colour is chosen.
    return f"{CASHIFY_REPAIR_URL}/user/order/quote?" + urlencode(entry)


async def cashify_model_card_names(page: Any) -> list[str]:
    names = await page.locator('.cursor-pointer img[src*="/product/"][alt]').evaluate_all(
        r"""
        images => [...new Set(images.map(image => image.alt.trim()).filter(Boolean))]
        """
    )
    return [normalize_space(str(name)) for name in names if normalize_space(str(name))]


async def cashify_series_labels(page: Any) -> list[str]:
    """Visible series tabs on a Cashify brand page, e.g. "Galaxy Fold Series"."""
    # FRAGILE SITE ASSUMPTION: series tabs are <li> items whose text ends in
    # "Series"; hidden laptop-series menu entries are anchors, not list items.
    labels = await page.evaluate(
        r"""
        () => [...new Set(
          [...document.querySelectorAll("li")]
            .filter(item => /series$/i.test(item.textContent.trim()) && item.getBoundingClientRect().height > 0)
            .map(item => item.textContent.trim())
        )]
        """
    )
    return [normalize_space(str(label)) for label in labels if label]


async def select_cashify_series(page: Any, label: str) -> bool:
    """Click a series tab so the model grid switches to that series."""
    clicked = await page.evaluate(
        r"""
        label => {
          const item = [...document.querySelectorAll("li")].find(
            item => item.textContent.trim() === label && item.getBoundingClientRect().height > 0
          );
          if (!item) return false;
          (item.querySelector(".cursor-pointer") || item).click();
          return true;
        }
        """,
        label,
    )
    if clicked:
        await page.wait_for_timeout(1500)
    return bool(clicked)


async def load_all_cashify_model_cards(page: Any) -> None:
    """Scroll Cashify's model grid until its lazy-loaded repair links settle."""
    # FRAGILE SITE ASSUMPTION: Cashify currently appends more model cards while
    # the page scrolls. Without this, only the initially rendered cards are read.
    selector = 'a[href*="/repair/"]'
    stable_rounds = 0
    previous_count = -1
    for _ in range(20):
        current_count = await page.locator(selector).count()
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await page.wait_for_timeout(700)
        next_count = await page.locator(selector).count()
        if next_count == current_count == previous_count:
            stable_rounds += 1
            if stable_rounds >= 2:
                break
        else:
            stable_rounds = 0
        previous_count = next_count
    await page.evaluate("window.scrollTo(0, 0)")


async def goto_catalog_page(page: Any, url: str) -> None:
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=60000)
    except Exception as exc:
        LOGGER.warning("Page navigation timed out; checking whether content is usable: %s", url)
        await page.wait_for_timeout(3000)
        if not await page.locator("body").count():
            raise exc
    try:
        await page.wait_for_load_state("networkidle", timeout=10000)
    except Exception:
        LOGGER.info("Continuing after networkidle timeout: %s", url)
    await dismiss_common_popups(page)
    await page.wait_for_timeout(1200)


async def open_oppo_series(page: Any, url: str, series_label: str) -> None:
    # FRAGILE SITE ASSUMPTION: OPPO's India page currently renders phone series
    # as li.sidebar-item cards and phone models as .product-item cards.
    try:
        change = page.get_by_text("Change", exact=True).first
        if await change.count() and await change.is_visible(timeout=800):
            await change.click(timeout=2500)
            await page.wait_for_timeout(1000)
    except Exception:
        pass
    if not await visible_texts(page, "li.sidebar-item"):
        await goto_catalog_page(page, url)
    try:
        await click_visible_text(page, "li.sidebar-item", series_label)
    except Exception:
        await goto_catalog_page(page, url)
        await click_visible_text(page, "li.sidebar-item", series_label)
    await page.wait_for_timeout(1200)
    if not await visible_texts(page, ".product-item"):
        await goto_catalog_page(page, url)
        try:
            await click_visible_text(page, "li.sidebar-item", series_label)
        except Exception:
            LOGGER.warning("OPPO product cards are not visible after selecting series: %s", series_label)
        await page.wait_for_timeout(1200)


async def open_realme_series(page: Any, url: str, series_label: str) -> None:
    # FRAGILE SITE ASSUMPTION: realme's India page currently renders mobile
    # series in .main-left .item-content-i and product cards in .main-right .item.
    try:
        change = page.get_by_text("Change device", exact=False).first
        if await change.count() and await change.is_visible(timeout=800):
            await change.click(timeout=2500)
            await page.wait_for_timeout(1000)
    except Exception:
        pass
    if not await visible_texts(page, ".main-left .item-content-i"):
        await goto_catalog_page(page, url)
    try:
        await click_visible_text(page, ".main-left .item-content-i", series_label)
    except Exception:
        await goto_catalog_page(page, url)
        await click_visible_text(page, ".main-left .item-content-i", series_label)
    await page.wait_for_timeout(1200)


async def visible_texts(page: Any, selector: str) -> list[str]:
    return await page.locator(selector).evaluate_all(
        """
        elements => elements
          .filter(element => {
            const box = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          })
          .map(element => element.innerText.trim())
          .filter(Boolean)
        """
    )


async def click_visible_text(page: Any, selector: str, text: str) -> None:
    clicked = await page.locator(selector).evaluate_all(
        """
        (elements, wanted) => {
          const normalizedWanted = wanted.replace(/\\s+/g, ' ').trim();
          const match = elements.find(element => {
            const box = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            const normalizedText = element.innerText.replace(/\\s+/g, ' ').trim();
            return box.width > 0
              && box.height > 0
              && style.visibility !== 'hidden'
              && style.display !== 'none'
              && normalizedText === normalizedWanted;
          });
          if (!match) return false;
          match.scrollIntoView({ block: 'center', inline: 'center' });
          match.click();
          return true;
        }
        """,
        text,
    )
    if not clicked:
        raise ValueError(f"Visible element not found for selector {selector!r} and text {text!r}")


def save_catalog_rows(
    conn: sqlite3.Connection,
    brand: str,
    model: str,
    url: str,
    raw_rows: list[str],
) -> int:
    saved = 0
    for raw_row in raw_rows:
        parsed = parse_catalog_price_row(raw_row)
        if not parsed:
            continue
        part, price_text, price_value, currency = parsed
        if is_non_spare_part(part):
            continue
        entry = TrackerEntry(brand, model, part, url, currency or "INR", [], "body")
        save_result(
            conn,
            entry,
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
            price_text,
            price_value,
            currency or "INR",
            "ok",
        )
        saved += 1
    return saved


def save_structured_price_rows(
    conn: sqlite3.Connection,
    brand: str,
    model: str,
    url: str,
    rows: list[dict[str, Any]],
) -> int:
    saved = 0
    for row in rows:
        part = normalize_space(str(row.get("part") or ""))
        price_value = coerce_price_value(row.get("price_value") or row.get("price"))
        if not part or price_value is None or is_non_spare_part(part):
            continue
        currency = normalize_currency(str(row.get("currency") or "INR"))
        price_text = str(row.get("price_text") or format_price_text(currency, price_value))
        entry = TrackerEntry(brand, model, part, url, currency or "INR", [], "body")
        save_result(
            conn,
            entry,
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
            normalize_space(f"{part} {price_text}"),
            price_value,
            currency or "INR",
            "ok",
        )
        saved += 1
    return saved


def save_catalog_error(conn: sqlite3.Connection, brand: str, model: str, url: str, message: str) -> None:
    entry = TrackerEntry(brand, model, "catalog discovery", url, "INR", [], "body")
    save_result(
        conn,
        entry,
        datetime.now(timezone.utc).isoformat(timespec="seconds"),
        None,
        None,
        "INR",
        "error",
        message,
    )


async def api_get_json(request: Any, url: str, headers: dict[str, str] | None = None, **kwargs: Any) -> Any:
    response = await request.get(url, headers=headers or {}, **kwargs)
    if not response.ok:
        raise ValueError(f"GET {url} failed with HTTP {response.status}: {(await response.text())[:300]}")
    return await response.json()


async def api_post_json(
    request: Any,
    url: str,
    payload: dict[str, Any] | None,
    headers: dict[str, str] | None = None,
    form: dict[str, str] | None = None,
) -> Any:
    response = await request.post(url, data=payload, form=form, headers=headers or {})
    if not response.ok:
        raise ValueError(f"POST {url} failed with HTTP {response.status}: {(await response.text())[:300]}")
    return await response.json()


def oneplus_headers() -> dict[str, str]:
    return {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "Origin": "https://service.oneplus.com",
        "Referer": "https://service.oneplus.com/in/spare-parts-price",
    }


def mi_headers() -> dict[str, str]:
    return {
        "Accept": "application/json, text/plain, */*",
        "Authorization": MI_API_AUTH,
        "Origin": "https://www.mi.com",
        "Referer": MI_SUPPORT_URL,
    }


def oneplus_price_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for group in payload.get("data", {}).get("partPriceList", []) or []:
        children = group.get("childList") or [group]
        for item in children:
            price_value = coerce_price_value(item.get("discountRetailPrice") or item.get("retailPrice"))
            if price_value is None:
                continue
            part = item.get("partName") or item.get("lv3ClassificationName") or group.get("groupName")
            rows.append(
                {
                    "part": part,
                    "price_value": price_value,
                    "currency": item.get("retailPriceCurrency") or "INR",
                }
            )
    return rows


async def fetch_mi_model_rows(request: Any, model_name: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    limit = 200
    offset = 0
    while True:
        payload = await api_get_json(
            request,
            f"{MI_API_BASE}/spare-part",
            headers=mi_headers(),
            params={
                "sort": "id",
                "order": "DESC",
                "query": f"modelname:eq:{model_name}",
                "limit": str(limit),
                "offset": str(offset),
            },
        )
        batch = payload.get("results") or []
        for item in batch:
            detail = normalize_space(str(item.get("sparePartDetails") or ""))
            category = normalize_space(str(item.get("category") or ""))
            part = detail if not category or category.lower() in detail.lower() else f"{category} - {detail}"
            rows.append(
                {
                    "part": part,
                    "price_value": item.get("partPrice"),
                    "currency": "INR",
                }
            )
        count = int(payload.get("count") or len(batch))
        offset += len(batch)
        if not batch or offset >= count:
            break
    return rows


def vivo_price_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    spare_part_vo = payload.get("data", {}).get("sparePartVO", {})
    currency = spare_part_vo.get("spareCompany") or "INR"
    for item in spare_part_vo.get("sparePartsVoList") or []:
        price_text = item.get("materialPrice") or item.get("promotionPrice") or item.get("price")
        rows.append(
            {
                "part": item.get("name"),
                "price_text": price_text,
                "price_value": coerce_price_value(price_text),
                "currency": currency,
            }
        )
    return rows


def motorola_price_rows(text: str) -> dict[str, list[dict[str, Any]]]:
    rows_by_model: dict[str, list[dict[str, Any]]] = {}
    model_name: str | None = None
    # The source has a model heading such as "XT2503-2 Motorola edge 60"
    # followed by spare-part lines such as "Battery: 1960".
    model_pattern = re.compile(r"^(XT[\w-]+\s+.+)$", re.IGNORECASE)
    part_pattern = re.compile(r"^(?P<part>[^:]{2,}):\s*(?:₹|Rs\.?\s*|INR\s*)?(?P<price>\d[\d,]*(?:\.\d{1,2})?)\*?$")
    for raw_line in text.splitlines():
        line = normalize_space(raw_line)
        model_match = model_pattern.match(line)
        if model_match:
            model_name = model_match.group(1)
            rows_by_model.setdefault(model_name, [])
            continue
        if not model_name:
            continue
        part_match = part_pattern.match(line)
        if not part_match:
            continue
        part = part_match.group("part")
        if is_non_spare_part(part):
            continue
        price_value = coerce_price_value(part_match.group("price"))
        if price_value is not None:
            rows_by_model[model_name].append(
                {"part": part, "price_value": price_value, "currency": "INR"}
            )
    return {model: rows for model, rows in rows_by_model.items() if rows}


def cashify_price_rows(text: str) -> list[dict[str, Any]]:
    lines = [normalize_space(line) for line in text.splitlines() if normalize_space(line)]
    try:
        start = lines.index("Pick Your Repair Service") + 1
    except ValueError:
        return []
    end = next(
        (index for index in range(start, len(lines)) if lines[index] == "Looking for other repair service?"),
        len(lines),
    )
    rows: list[dict[str, Any]] = []
    seen_parts: set[str] = set()
    for index in range(start, end - 1):
        part = lines[index]
        if not part or find_currency_price_match(part) or is_non_spare_part(part):
            continue
        price_match = re.fullmatch(r"(?:₹|Rs\.?\s*|INR\s*)(\d[\d,]*(?:\.\d{1,2})?)", lines[index + 1])
        if not price_match:
            continue
        normalized_part = part.lower()
        if normalized_part in seen_parts:
            continue
        price_value = coerce_price_value(price_match.group(1))
        if price_value is not None:
            rows.append({"part": part, "price_value": price_value, "currency": "INR"})
            seen_parts.add(normalized_part)
    return rows


def cashify_brand_name(url: str) -> str:
    slug = url.rstrip("/").split("/")[-1].lower()
    labels = {
        "apple": "Apple",
        "asus": "Asus",
        "google": "Google",
        "honor": "Honor",
        "infinix": "Infinix",
        "iqoo": "iQOO",
        "motorola": "Motorola",
        "nokia": "Nokia",
        "nothing": "Nothing",
        "oneplus": "OnePlus",
        "oppo": "OPPO",
        "poco": "POCO",
        "realme": "realme",
        "samsung": "Samsung",
        "vivo": "vivo",
        "xiaomi": "Xiaomi",
    }
    return labels.get(slug, slug.replace("-", " ").title())


def coerce_price_value(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    _, parsed = parse_price(str(value))
    return parsed


def format_price_text(currency: str | None, price_value: float) -> str:
    label = "INR" if not currency or currency == "INR" else currency
    return f"{label} {price_value:,.0f}" if float(price_value).is_integer() else f"{label} {price_value:,.2f}"


def parse_catalog_price_row(text: str) -> tuple[str, str, float, str | None] | None:
    clean = normalize_space(text)
    match = find_currency_price_match(clean)
    if not match:
        return None
    currency, value = parse_price(clean)
    if value is None:
        return None
    part = normalize_space(clean[: match.start()].strip(" :-|"))
    if not part:
        return None
    return part, clean, value, currency


def is_non_spare_part(part: str) -> bool:
    part_lower = part.lower()
    return any(
        marker in part_lower
        for marker in [
            "repair, inspection",
            "service fee",
            "service type",
            "software installation",
            "software upgrade",
            "return without repair",
        ]
    )


def parse_apple_service_prices(text: str) -> list[tuple[str, str, float]]:
    lines = [line for line in (normalize_space(line) for line in text.splitlines()) if line]
    results = []
    service_started = False
    for index, line in enumerate(lines):
        if line == "Estimated service cost":
            service_started = True
            continue
        if service_started and line in {"Get a service", "Where can I get a service?"}:
            break
        if not service_started or PRICE_RE.search(line):
            continue
        if index + 1 < len(lines) and "INR" in lines[index + 1]:
            price_line = lines[index + 1]
            _, value = parse_price(price_line)
            if value is not None:
                results.append((line, f"{line} {price_line}", value))
    return results


def css_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


async def scrape_entry(page: Any, entry: TrackerEntry) -> str:
    await page.goto(entry.url, wait_until="domcontentloaded")
    await page.wait_for_load_state("networkidle")
    await dismiss_common_popups(page)

    # FRAGILE SITE ASSUMPTION: every action below depends on the current page
    # labels/selectors. When Apple or Samsung redesign a flow, update config.json
    # before changing Python code.
    for action in entry.actions:
        await perform_action(page, action)
        await page.wait_for_timeout(int(action.get("post_delay_ms", 1000)))

    locator = page.locator(entry.price_selector).first
    await locator.wait_for(state="visible")
    text = await locator.inner_text()
    if not PRICE_RE.search(text):
        raise ValueError(f"Price selector matched text without a parseable amount: {text[:300]}")
    return extract_relevant_price_text(text, entry.part)


async def dismiss_common_popups(page: Any) -> None:
    labels = [
        "Accept",
        "Accept All",
        "I agree",
        "Continue",
        "No thanks",
        "Close",
    ]
    for label in labels:
        try:
            button = page.get_by_role("button", name=re.compile(label, re.I)).first
            if await button.count() and await button.is_visible(timeout=750):
                await button.click(timeout=1500)
                await page.wait_for_timeout(500)
        except Exception:
            continue


async def perform_action(page: Any, action: dict[str, Any]) -> None:
    action_type = action.get("type")
    if action_type == "click":
        await page.locator(required(action, "selector")).first.click(force=bool(action.get("force", False)))
    elif action_type == "click_text":
        await page.get_by_text(required(action, "text"), exact=bool(action.get("exact", False))).first.click(
            force=bool(action.get("force", False))
        )
    elif action_type == "fill":
        locator = page.locator(required(action, "selector")).first
        await locator.fill(str(action.get("value", "")))
        if action.get("press"):
            await locator.press(str(action["press"]))
    elif action_type == "select_option":
        locator = page.locator(required(action, "selector")).first
        if "label" in action:
            await locator.select_option(label=str(action["label"]))
        elif "value" in action:
            await locator.select_option(value=str(action["value"]))
        elif "index" in action:
            await locator.select_option(index=int(action["index"]))
        else:
            raise ValueError("select_option action requires label, value, or index")
    elif action_type == "wait_for_selector":
        await page.locator(required(action, "selector")).first.wait_for(state=action.get("state", "visible"))
    elif action_type == "wait_for_timeout":
        await page.wait_for_timeout(int(action.get("ms", 1000)))
    else:
        raise ValueError(f"Unsupported action type: {action_type}")


def parse_price(text: str) -> tuple[str | None, float | None]:
    match = find_currency_price_match(text) or PRICE_RE.search(text)
    if not match:
        return None, None
    currency = normalize_currency(match.group("currency"))
    amount = float(match.group("amount").replace(",", ""))
    return currency, amount


def find_currency_price_match(text: str) -> re.Match[str] | None:
    matches = list(CURRENCY_PREFIX_PRICE_RE.finditer(text)) + list(CURRENCY_SUFFIX_PRICE_RE.finditer(text))
    if not matches:
        return None
    return sorted(matches, key=lambda match: match.start())[0]


def normalize_currency(currency: str | None) -> str | None:
    if not currency:
        return None
    if currency.lower().startswith("rs") or currency.upper() == "INR" or currency == "₹":
        return "INR"
    if currency == "$":
        return "USD"
    if currency == "€":
        return "EUR"
    if currency == "£":
        return "GBP"
    return currency.upper()


def extract_relevant_price_text(text: str, part: str) -> str:
    lines = [line for line in (normalize_space(line) for line in text.splitlines()) if line]
    part_lower = part.lower()
    for index, line in enumerate(lines):
        if part_lower in line.lower() and PRICE_RE.search(line):
            return line
        if part_lower in line.lower():
            for nearby in lines[index + 1 : index + 5]:
                if PRICE_RE.search(nearby):
                    return f"{line} {nearby}"
    for line in lines:
        if PRICE_RE.search(line):
            return line
    return normalize_space(text)


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def export_csv(db_path: Path, output_path: Path) -> None:
    conn = connect_db(db_path)
    rows = conn.execute(
        """
        SELECT date, brand, model, part, price, price_value, currency, status, error, url
        FROM price_history
        ORDER BY date, brand, model, part
        """
    ).fetchall()
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["date", "brand", "model", "part", "price", "price_value", "currency", "status", "error", "url"])
        writer.writerows(rows)
    conn.close()


def plot_history(db_path: Path, output_path: Path, brand: str | None, model: str | None, part: str | None) -> None:
    import pandas as pd
    import matplotlib.pyplot as plt

    conn = connect_db(db_path)
    query = "SELECT date, brand, model, part, price_value FROM price_history WHERE status = 'ok' AND price_value IS NOT NULL"
    params: list[str] = []
    if brand:
        query += " AND brand = ?"
        params.append(brand)
    if model:
        query += " AND model = ?"
        params.append(model)
    if part:
        query += " AND part = ?"
        params.append(part)
    frame = pd.read_sql_query(query, conn, params=params, parse_dates=["date"])
    conn.close()
    if frame.empty:
        raise SystemExit("No successful price rows matched the requested filter.")

    frame["series"] = frame["brand"] + " - " + frame["model"] + " - " + frame["part"]
    fig, ax = plt.subplots(figsize=(11, 6))
    for label, group in frame.sort_values("date").groupby("series"):
        ax.plot(group["date"], group["price_value"], marker="o", label=label)
    ax.set_title("Spare Part Price History")
    ax.set_xlabel("Date")
    ax.set_ylabel("Price")
    ax.grid(True, alpha=0.25)
    ax.legend()
    fig.autofmt_xdate()
    fig.tight_layout()
    fig.savefig(output_path, dpi=160)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Track mobile spare-part prices over time.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="Scrape all enabled entries and save results.")
    run_parser.add_argument("--config", default="config.json", type=Path)

    dry_run_parser = subparsers.add_parser("dry-run", help="Test selectors without writing to the database.")
    dry_run_parser.add_argument("--config", default="config.json", type=Path)

    init_parser = subparsers.add_parser("init-db", help="Create the SQLite database/table.")
    init_parser.add_argument("--db", default="price_history.sqlite3", type=Path)

    export_parser = subparsers.add_parser("export-csv", help="Export recorded history to CSV.")
    export_parser.add_argument("--db", default="price_history.sqlite3", type=Path)
    export_parser.add_argument("--output", default="price_history.csv", type=Path)

    plot_parser = subparsers.add_parser("plot", help="Plot price history to a PNG file.")
    plot_parser.add_argument("--db", default="price_history.sqlite3", type=Path)
    plot_parser.add_argument("--output", default="price_history.png", type=Path)
    plot_parser.add_argument("--brand")
    plot_parser.add_argument("--model")
    plot_parser.add_argument("--part")

    discover_parser = subparsers.add_parser("discover-all", help="Discover all model/spare-part prices from supported pages.")
    discover_parser.add_argument("--brand", choices=["all", *DISCOVERY_BRANDS], default="all")
    discover_parser.add_argument("--delay", type=float, default=3.0)
    discover_parser.add_argument("--max-models", type=int)
    discover_parser.add_argument("--model", help="Only crawl models containing this text.")
    discover_parser.add_argument("--parallel", type=int, default=4, help="How many brand crawls run at the same time.")
    push_parser = subparsers.add_parser("push-history", help="Upload the local SQLite history to the remote price store.")
    push_parser.add_argument("--db", default="price_history.sqlite3", type=Path)
    push_parser.add_argument("--batch", type=int, default=1000)
    push_parser.add_argument("--after-id", type=int, default=0, help="Only upload rows with an id above this.")
    discover_parser.add_argument(
        "--cashify-city", default=DEFAULT_CASHIFY_CITY,
        help=f"City whose Cashify prices to read ({', '.join(sorted(CASHIFY_CITIES))}).",
    )
    discover_parser.add_argument("--db", default="price_history.sqlite3", type=Path)
    discover_parser.add_argument(
        "--samsung-series",
        choices=["galaxy-z", "galaxy-s", "galaxy-a", "galaxy-m", "galaxy-f", "galaxy-tab"],
        help="Only crawl one Samsung series. Useful for retrying a failed series.",
    )
    discover_parser.add_argument(
        "--oppo-series",
        choices=OPPO_MOBILE_SERIES,
        help="Only crawl one OPPO series. Useful for retrying a failed series.",
    )
    discover_parser.add_argument(
        "--realme-series",
        choices=REALME_MOBILE_SERIES,
        help="Only crawl one realme series. Useful for retrying a failed series.",
    )

    return parser


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if REMOTE_STORE is not None:
        LOGGER.info("Prices are also being sent to %s", REMOTE_STORE.base_url)
    args = build_parser().parse_args(argv)
    if args.command == "run":
        return asyncio.run(run_tracker(args.config))
    if args.command == "dry-run":
        return asyncio.run(dry_run(args.config))
    if args.command == "init-db":
        connect_db(args.db).close()
        LOGGER.info("Initialized %s", args.db)
        return 0
    if args.command == "export-csv":
        export_csv(args.db, args.output)
        LOGGER.info("Exported %s", args.output)
        return 0
    if args.command == "plot":
        plot_history(args.db, args.output, args.brand, args.model, args.part)
        LOGGER.info("Wrote %s", args.output)
        return 0
    if args.command == "push-history":
        return push_history(args.db, args.batch, args.after_id)
    if args.command == "discover-all":
        return asyncio.run(
            discover_all(
                args.brand,
                args.delay,
                args.max_models,
                args.samsung_series,
                args.oppo_series,
                args.realme_series,
                args.model,
                args.db,
                args.parallel,
                args.cashify_city,
            )
        )
    raise AssertionError(f"Unhandled command: {args.command}")


if __name__ == "__main__":
    sys.exit(main())
