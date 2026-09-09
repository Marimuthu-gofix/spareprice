from __future__ import annotations

import argparse
import asyncio
import csv
import json
import logging
import os
import re
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

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
DISCOVERY_BRANDS = ["apple", "samsung", "oppo", "realme", "oneplus", "mi", "vivo"]
ONEPLUS_SUPPORT_URL = "https://service.oneplus.com/in/spare-parts-price#/"
ONEPLUS_API_BASE = "https://ind-sow-cms.oneplus.com/oppo-api"
MI_SUPPORT_URL = "https://www.mi.com/in/support/spare-part-prices/model?category=Mobile"
MI_API_BASE = "https://in-go.buy.mi.com/in/serviceplus/api/fos/public/v1/mi-store"
MI_API_AUTH = "Basic bWlzdG9yZS1zZXJ2aWNlcGx1cy1pbnRlZ3JhdGlvbjp4aWFvbWlAQURNSU4="
VIVO_SUPPORT_URL = "https://www.vivo.com/in/support/accessory"


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


def browser_launch_args() -> list[str]:
    return ["--no-sandbox", "--disable-dev-shm-usage"]


def model_matches_filter(model: str, model_filter: str | None) -> bool:
    if not model_filter:
        return True
    return model_filter.lower() in model.lower()


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
) -> int:
    from playwright.async_api import async_playwright

    conn = connect_db(default_db_path("price_history.sqlite3"))
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, args=browser_launch_args())
        context = await browser.new_context(locale="en-IN", viewport={"width": 1366, "height": 900})
        if brand in {"all", "apple"}:
            await discover_apple(context, conn, delay_seconds, max_models, model_filter)
        if brand in {"all", "samsung"}:
            await discover_samsung(browser, conn, delay_seconds, max_models, samsung_series, model_filter)
        if brand in {"all", "oppo"}:
            await discover_oppo(browser, conn, delay_seconds, max_models, oppo_series, model_filter)
        if brand in {"all", "realme"}:
            await discover_realme(browser, conn, delay_seconds, max_models, realme_series, model_filter)
        if brand in {"all", "oneplus"}:
            await discover_oneplus(context, conn, delay_seconds, max_models, model_filter)
        if brand in {"all", "mi"}:
            await discover_mi(context, conn, delay_seconds, max_models, model_filter)
        if brand in {"all", "vivo"}:
            await discover_vivo(context, conn, delay_seconds, max_models, model_filter)
        await context.close()
        await browser.close()
    conn.close()
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
        context = await browser.new_context(locale="en-IN", viewport={"width": 1366, "height": 900})
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
    context = await browser.new_context(locale="en-IN", viewport={"width": 1366, "height": 900})
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
    context = await browser.new_context(locale="en-IN", viewport={"width": 1366, "height": 900})
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
            )
        )
    raise AssertionError(f"Unhandled command: {args.command}")


if __name__ == "__main__":
    sys.exit(main())
