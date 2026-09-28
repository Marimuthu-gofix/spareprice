// SQLite storage for scraped prices, using Node's built-in sqlite module
// (Node 22.13+ / 24 / 26). Ported from connect_db / save_result in spareprice.py.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RemotePriceStore } from "../shared/priceStore.js";
import {
  coercePriceValue, formatPriceText, isNonSparePart, normalizeCurrency, normalizeSpace, parseCatalogPriceRow, utcNow,
} from "../shared/text.js";

// Optional remote store (see ../hostinger_api/README.md). Every saved row also
// goes there when PRICE_API_URL and PRICE_API_KEY are set.
export const REMOTE_STORE = RemotePriceStore.fromEnv();

export function defaultDbPath(fallback) {
  return process.env.DB_PATH || fallback;
}

export function connectDb(dbPath) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
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
    );
    CREATE INDEX IF NOT EXISTS idx_price_history_lookup ON price_history (brand, model, part, date);
  `);
  const insert = db.prepare(`
    INSERT INTO price_history (date, brand, model, part, price, price_value, currency, url, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return { db, insert, path: dbPath, close: () => db.close() };
}

/** One observation, written locally and queued for the remote store. */
export function saveResult(conn, entry, timestamp, priceText, priceValue, currency, status, error = null) {
  const row = {
    date: timestamp,
    brand: entry.brand,
    model: entry.model,
    part: entry.part,
    price: priceText,
    price_value: priceValue,
    currency: currency || entry.currency || null,
    url: entry.url,
    status,
    error,
  };
  conn.insert.run(row.date, row.brand, row.model, row.part, row.price, row.price_value, row.currency, row.url, row.status, row.error);
  if (REMOTE_STORE) REMOTE_STORE.add(row);
}

function entryFor(brand, model, part, url, currency) {
  return { brand, model, part, url, currency: currency || "INR", actions: [], priceSelector: "body" };
}

/** Rows like "Battery ₹1,390" (OPPO, realme). Returns how many were saved. */
export function saveCatalogRows(conn, brand, model, url, rawRows) {
  let saved = 0;
  for (const rawRow of rawRows) {
    const parsed = parseCatalogPriceRow(rawRow);
    if (!parsed || isNonSparePart(parsed.part)) continue;
    const currency = parsed.currency || "INR";
    saveResult(conn, entryFor(brand, model, parsed.part, url, currency), utcNow(), parsed.priceText, parsed.priceValue, currency, "ok");
    saved += 1;
  }
  return saved;
}

/** Rows as {part, price_value | price, currency, price_text?}. Returns how many were saved. */
export function saveStructuredPriceRows(conn, brand, model, url, rows) {
  let saved = 0;
  for (const row of rows) {
    const part = normalizeSpace(String(row.part ?? ""));
    const priceValue = coercePriceValue(row.price_value ?? row.price);
    if (!part || priceValue === null || isNonSparePart(part)) continue;
    const currency = normalizeCurrency(String(row.currency || "INR")) || "INR";
    const priceText = String(row.price_text || formatPriceText(currency, priceValue));
    saveResult(conn, entryFor(brand, model, part, url, currency), utcNow(), normalizeSpace(`${part} ${priceText}`), priceValue, currency, "ok");
    saved += 1;
  }
  return saved;
}

export function saveCatalogError(conn, brand, model, url, message) {
  saveResult(conn, entryFor(brand, model, "catalog discovery", url, "INR"), utcNow(), null, null, "INR", "error", message);
}

export function errorMessage(error) {
  return `${error?.name || "Error"}: ${error?.message || error}`;
}
