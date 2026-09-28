// Everything that turns stored rows into what the dashboard shows: the latest
// price per part, official-vs-Cashify matching, search, sorting, paging and
// the stats. Ported from dashboard.py.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { log } from "../shared/log.js";
import { RemotePriceStore } from "../shared/priceStore.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DISPLAY_TIMEZONE = "Asia/Kolkata";
export const SUPPORTED_BRANDS = [
  "Apple", "Asus", "Google", "Honor", "Infinix", "iQOO", "Mi", "Motorola",
  "Nokia", "Nothing", "OnePlus", "OPPO", "POCO", "realme", "Samsung", "vivo", "Xiaomi",
];
export const PER_PAGE_OPTIONS = [25, 50, 100, 250];
export const HISTORY_PER_PAGE_OPTIONS = [10, 25, 50, 100];
export const HISTORY_PER_PAGE_DEFAULT = 10;
export const HOSTED_READ_ONLY = Boolean(process.env.VERCEL);
// When PRICE_API_URL / PRICE_API_KEY are set, prices are read from the remote
// store (hostinger_api/) instead of the local SQLite file.
export const REMOTE_STORE = RemotePriceStore.fromEnv();

export function dbPath() {
  const configured = process.env.DB_PATH;
  if (configured) return path.resolve(configured);
  const local = path.join(ROOT, "price_history.sqlite3");
  const parent = path.join(ROOT, "..", "price_history.sqlite3");
  // The Python project next door may already hold the history.
  return !fs.existsSync(local) && fs.existsSync(parent) ? parent : local;
}

// ------------------------------------------------------------ formatting
export function money(value, currency) {
  if (value === null || value === undefined) return "-";
  const prefix = currency === "INR" ? "Rs " : currency ? `${currency} ` : "";
  return `${prefix}${Math.round(value).toLocaleString("en-US")}`;
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TIMEZONE, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
});

export function parseIso(value) {
  if (!value) return null;
  const date = new Date(String(value).replace("Z", "+00:00"));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "24 Sep 2026, 01:09 PM" in India time. */
export function localDate(value) {
  const date = parseIso(value);
  if (!date) return value || "-";
  const parts = Object.fromEntries(dateFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${(parts.dayPeriod || "").toUpperCase()}`;
}

const dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: DISPLAY_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });

export function localDay(value) {
  const date = value instanceof Date ? value : parseIso(value);
  return date ? dayFormatter.format(date) : "";
}

// ------------------------------------------------------- name matching
const COMPETITOR_BRAND_ALIASES = { xiaomi: "mi", poco: "mi" };
const MODEL_PREFIX_RE = /^(?:xt\d{4}(?:-\d+)?\s+)?(?:(?:apple|samsung|xiaomi|oppo|realme|oneplus|vivo|iqoo|motorola|moto)\s+)*/;
const IPHONE_SE_RE = /iphone se\s*\(?(\d)(?:st|nd|rd|th) generation\)?/;
const IPHONE_SE_YEARS = { 2016: "1", 2020: "2", 2022: "3" };
const LOOSE_SUFFIX_RE = /\s*\(?5g\)?$/;
const cache = (fn) => {
  const memo = new Map();
  return (value) => {
    if (memo.has(value)) return memo.get(value);
    const result = fn(value);
    memo.set(value, result);
    return result;
  };
};

/** Lowercase, replace non-breaking spaces and collapse whitespace. */
export const cleanText = cache((value) => String(value ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim().toLowerCase());
/** Display text with non-breaking spaces and doubled whitespace removed. */
export const cleanLabel = cache((value) => String(value ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim());

export function brandKey(brand) {
  const key = cleanText(brand);
  return COMPETITOR_BRAND_ALIASES[key] || key;
}

const modelKeyStrict = cache((model) => {
  let key = cleanText(model).replace(MODEL_PREFIX_RE, "");
  key = key.replace(IPHONE_SE_RE, (_, gen) => `iphone se gen ${gen}`);
  key = key.replace(/iphone se (2016|2020|2022)$/, (_, year) => `iphone se gen ${IPHONE_SE_YEARS[year]}`);
  if (key === "iphone se") key = "iphone se gen 1";
  // Samsung writes "Galaxy Z Fold7"; Cashify writes "Galaxy Z Fold 7".
  return key.replace(/\b(fold|flip|note)\s+(?=\d)/g, "$1");
});
const modelKeyLoose = cache((model) => modelKeyStrict(model).replace(LOOSE_SUFFIX_RE, ""));

/** Canonical model name shared by every source. loose=true drops a trailing "5G". */
export function modelKey(model, loose = false) {
  return loose ? modelKeyLoose(model) : modelKeyStrict(model);
}

function searchText(row, extra = []) {
  const model = String(row.model || "");
  return [cleanText(row.brand), cleanText(model), cleanText(row.part), cleanText(row.price), modelKey(model), ...extra.map(cleanText)].join(" ");
}

const SEARCH_BRAND_WORDS = new Set(["apple", "samsung", "xiaomi", "oppo", "realme", "oneplus", "vivo", "iqoo", "motorola", "moto"]);

export function matchesSearch(row, search, extra = []) {
  const needle = cleanText(search);
  if (searchText(row, extra).includes(needle)) return true;
  // Fall back to the canonical model name, so "Apple iPhone SE 2022" finds
  // "iPhone SE (3rd generation)". A brand named in the search must still match.
  const key = modelKey(search);
  if (!key || !modelKey(row.model).includes(key)) return false;
  const prefix = needle.endsWith(key) ? needle.slice(0, needle.length - key.length).split(/\s+/).filter(Boolean) : [];
  const named = new Set(prefix.filter((word) => SEARCH_BRAND_WORDS.has(word)).map((word) => (word === "moto" ? "motorola" : brandKey(word))));
  return !named.size || named.has(brandKey(row.brand));
}

export function priceSource(row) {
  const part = row.part || "";
  const url = row.url || "";
  if (part.startsWith("Cashify - ") || url.includes("cashify.in")) return "Cashify";
  return row.brand || "Official";
}

/** Fold vendor-specific part names into a shared category, or null. */
export const partCategory = cache((part) => {
  let name = String(part || "").toLowerCase();
  if (name.startsWith("cashify - ")) name = name.slice("cashify - ".length);
  name = name.replace(/-/g, " ").replace(/（/g, " (").replace(/）/g, ")");
  const has = (...words) => words.some((word) => name.includes(word));
  if (has("cable", "adapter", "charger", "headset", "cleaning", "s pen", "sim tray", "component repair", "inspection")) return null;
  if (name.includes("camera")) return name.includes("front") ? "Front Camera" : "Back Camera";
  if (has("proximity")) return "Proximity Sensor";
  if (has("aux", "headphone", "earphone jack")) return "Aux Jack";
  if (has("receiver", "earpiece")) return "Receiver";
  if (has("speaker")) return "Speaker";
  if (has("mic")) return "Mic";
  if (has("charging", "usb port", "sub board", "pcb sb")) return "Charging Jack";
  if (has("motherboard", "mainboard", "main board", "mother board", "pcb mb", "logic board")) return "Motherboard";
  if (has("sub screen", "cover screen", "cover display", "outer screen", "outer display", "cli display", "secondary display")) return "Cover Screen";
  if (has("screen", "display", "lcd", "lcm", "touch panel")) return "Screen";
  if (has("back cover", "back glass", "battery cover", "backcover", "rear cover", "rear glass", "back panel")) return "Back Cover";
  if (has("battery")) return "Battery";
  return null;
});

function isRecentEnough(dateValue, newest, windowHours = 36) {
  const checked = parseIso(dateValue);
  const latest = parseIso(newest);
  if (!checked || !latest) return true;
  return latest - checked <= windowHours * 3600 * 1000;
}

/** For every latest price, the latest prices for the same model and category from other sources. */
export function attachCompetitorPrices(latest) {
  const strict = new Map();
  const loose = new Map();
  const push = (map, key, row) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  };
  for (const row of latest) {
    row.source = priceSource(row);
    row.brand_key = brandKey(row.brand);
    row.model_key = modelKey(row.model);
    row.category = partCategory(row.part);
    row.competitors = [];
    if (row.category) {
      push(strict, `${row.brand_key}|${row.model_key}|${row.category}`, row);
      push(loose, `${row.brand_key}|${modelKey(row.model, true)}|${row.category}`, row);
    }
  }
  const others = (candidates, row) => {
    const seen = new Set();
    let found = [];
    for (const other of candidates || []) {
      const tag = `${other.source}|${other.part}`;
      if (other.source === row.source || seen.has(tag)) continue;
      seen.add(tag);
      found.push(other);
    }
    // Keep only the parts each source refreshed in its most recent check, so
    // stale part names (an old shortlist name) drop out.
    const newest = {};
    for (const other of found) newest[other.source] = [newest[other.source] || "", other.date || ""].sort().pop();
    found = found.filter((other) => isRecentEnough(other.date, newest[other.source]));
    return found.sort((a, b) => a.source.localeCompare(b.source) || a.part.localeCompare(b.part));
  };
  for (const row of latest) {
    if (!row.category) continue;
    let found = others(strict.get(`${row.brand_key}|${row.model_key}|${row.category}`), row);
    if (!found.length) found = others(loose.get(`${row.brand_key}|${modelKey(row.model, true)}|${row.category}`), row);
    row.competitors = found;
  }
}

/** Tag consecutive rows sharing (brand, model) so the template can collapse them. */
export function groupByModel(rows) {
  const keys = rows.map((row) => `${row.brand_key}|${row.model_key}`);
  const grouped = [];
  let groupIndex = -1;
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j < rows.length && keys[j] === keys[i]) j += 1;
    groupIndex += 1;
    const groupId = `g${groupIndex}`;
    const size = j - i;
    const slice = rows.slice(i, j);
    const sources = new Set(slice.map((row) => row.source)).size;
    // Title the accordion with the brand's own model name when we have it.
    const label = (slice.find((row) => row.source !== "Cashify") || slice[0]).model;
    for (let k = i; k < j; k++) grouped.push({ row: rows[k], groupStart: k === i, groupSize: size, groupId, groupSources: sources, groupLabel: label });
    i = j;
  }
  return grouped;
}

export function pageInfo(total, page, perPage, window = 2) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  page = Math.min(Math.max(page, 1), totalPages);
  const start = (page - 1) * perPage;
  const end = Math.min(start + perPage, total);
  const numbers = new Set([1, totalPages]);
  for (let p = page - window; p <= page + window; p++) if (p >= 1 && p <= totalPages) numbers.add(p);
  return {
    page, per_page: perPage, total, total_pages: totalPages, slice_start: start, slice_end: end,
    start: total ? start + 1 : 0, end, has_prev: page > 1, has_next: page < totalPages,
    prev_page: Math.max(1, page - 1), next_page: Math.min(totalPages, page + 1),
    page_numbers: [...numbers].sort((a, b) => a - b),
  };
}

// ---------------------------------------------------------- price data
const PRICE_COLUMNS = ["date", "brand", "model", "part", "price", "price_value", "currency", "status", "error", "url"];
// Older Cashify rows used names the site API now reports differently.
const LEGACY_PART_NAMES = { "Cashify - Motherboard": "Cashify - Motherboard Inspection", "Cashify - BACK PANEL": "Cashify - Back Panel" };

function compactRows(sourceRows) {
  const intern = new Map();
  const share = (value) => {
    if (typeof value !== "string") return value;
    if (!intern.has(value)) intern.set(value, value);
    return intern.get(value);
  };
  return sourceRows.map((source) => {
    const row = {};
    for (const column of PRICE_COLUMNS) {
      let value = source[column] ?? null;
      if (column === "part") value = LEGACY_PART_NAMES[value] || value;
      row[column] = column === "date" ? value : share(value);
    }
    return row;
  });
}

const priceData = { stamp: null };
let loading = null;

/** Rows, latest prices with competitor matches, and picker lists; cached until the store changes. */
export async function loadPriceData() {
  if (loading) return loading;
  loading = (async () => {
    const file = dbPath();
    let localStamp;
    try {
      const info = fs.statSync(file);
      localStamp = `${file}|${info.mtimeMs}|${info.size}`;
    } catch {
      localStamp = `${file}|0|0`;
    }
    let stamp = localStamp;
    let source = `local file ${path.basename(file)}`;
    let remoteError = "";
    let useRemote = false;
    if (REMOTE_STORE) {
      try {
        const remote = await REMOTE_STORE.status();
        stamp = `remote|${REMOTE_STORE.baseUrl}|${remote.count}|${remote.max_id}`;
        source = REMOTE_STORE.baseUrl;
        useRemote = true;
      } catch (error) {
        remoteError = error.message;
        log.warn(`Remote price store ${REMOTE_STORE.baseUrl} is unreachable: ${error.message}`);
        if (priceData.stamp !== null) {
          priceData.remote_error = remoteError;
          return priceData;
        }
        stamp = `remote-unavailable|${localStamp}`;
        source = `local file ${path.basename(file)} (remote store unreachable)`;
      }
    }
    if (priceData.stamp === stamp) {
      priceData.remote_error = remoteError;
      return priceData;
    }
    let rows;
    if (useRemote) {
      rows = compactRows(await REMOTE_STORE.fetchAll());
      rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    } else {
      let db = null;
      try {
        db = new DatabaseSync(file);
        db.exec(`CREATE TABLE IF NOT EXISTS price_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, brand TEXT NOT NULL, model TEXT NOT NULL, part TEXT NOT NULL,
          price TEXT, price_value REAL, currency TEXT, url TEXT NOT NULL, status TEXT NOT NULL, error TEXT)`);
        rows = compactRows(db.prepare("SELECT date, brand, model, part, price, price_value, currency, status, error, url FROM price_history ORDER BY date DESC").all());
      } finally {
        if (db) db.close();
      }
    }
    const latestByKey = new Map();
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.status === "ok") latestByKey.set(`${row.brand}|${row.model}|${row.part}`, row);
    }
    const latest = [...latestByKey.values()].map((row) => ({ ...row }));
    attachCompetitorPrices(latest);
    latest.sort(
      (a, b) =>
        a.brand_key.localeCompare(b.brand_key) || a.model_key.localeCompare(b.model_key) ||
        Number(a.source === "Cashify") - Number(b.source === "Cashify") || a.brand.localeCompare(b.brand) || a.part.localeCompare(b.part),
    );
    const modelNames = new Map();
    for (const row of latest) {
      const key = `${row.brand_key}|${row.model_key}`;
      if (!modelNames.has(key)) modelNames.set(key, cleanLabel(row.model));
    }
    Object.assign(priceData, {
      stamp, source, remote_error: remoteError, rows, latest,
      brands: [...new Set([...SUPPORTED_BRANDS, ...rows.map((row) => row.brand)])].sort((a, b) => a.localeCompare(b)),
      model_options: [...new Set(modelNames.values())].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
      suggestions: [...new Set(latest.map((row) => `${row.model} - ${row.part}`))].sort().slice(0, 500),
    });
    return priceData;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/** Drop the in-memory data so a scrape has room to run (small hosts only). */
export function releasePriceData() {
  if (!process.env.RENDER) return;
  for (const key of Object.keys(priceData)) delete priceData[key];
  priceData.stamp = null;
  if (global.gc) global.gc();
}

const SORT_KEYS = {
  brand: (r) => (r.brand || "").toLowerCase(),
  model: (r) => r.model_key,
  part: (r) => (r.part || "").toLowerCase(),
  price: (r) => (r.price_value === null ? -1 : r.price_value),
  date: (r) => r.date || "",
};

function compareBy(keyFn, reverse) {
  return (a, b) => {
    const x = keyFn(a);
    const y = keyFn(b);
    const result = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
    return reverse ? -result : result;
  };
}

export async function loadDashboard({
  search = "", selectedBrands = [], page = 1, perPage = 100, status = "", sort = "date", sortDir = "desc",
  paginate = true, historyPage = 1, historyPerPage = HISTORY_PER_PAGE_DEFAULT,
} = {}) {
  const selectedLower = new Set(selectedBrands.map((brand) => brand.toLowerCase()));
  const cached = await loadPriceData();
  let rows = cached.rows;
  const allLatest = cached.latest;
  let latest = [...allLatest];
  if (selectedLower.size) {
    latest = latest.filter((row) => selectedLower.has(row.brand.toLowerCase()));
    rows = rows.filter((row) => selectedLower.has(row.brand.toLowerCase()));
  }
  if (status === "ok" || status === "error") rows = rows.filter((row) => row.status === status);
  if (search) {
    latest = latest.filter((row) => matchesSearch(row, search));
    rows = rows.filter((row) => matchesSearch(row, search, [row.status]));
  }

  const sortKey = SORT_KEYS[sort] || SORT_KEYS.date;
  latest.sort(compareBy(sortKey, sortDir !== "asc"));
  if (!SORT_KEYS[sort] || sort === "date") {
    // Keep every model's rows together while ordering models by their most recent check.
    const firstSeen = new Map();
    for (const row of latest) {
      const key = `${row.brand_key}|${row.model_key}`;
      if (!firstSeen.has(key)) firstSeen.set(key, firstSeen.size);
    }
    latest.sort((a, b) => firstSeen.get(`${a.brand_key}|${a.model_key}`) - firstSeen.get(`${b.brand_key}|${b.model_key}`));
  }

  const latestTotal = latest.length;
  perPage = PER_PAGE_OPTIONS.includes(perPage) ? perPage : 100;
  if (!paginate) {
    perPage = Math.max(latestTotal, 1);
    page = 1;
  }
  const pagination = pageInfo(latestTotal, page, perPage);
  const pagedLatest = groupByModel(latest.slice(pagination.slice_start, pagination.slice_end));

  const chartLimit = search ? 24 : 12;
  const chartCandidates = [...latest].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, chartLimit);
  const chartKeys = new Map(chartCandidates.map((row) => [`${row.brand}|${row.model}|${row.part}`, row]));
  const historyByKey = new Map();
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const key = `${row.brand}|${row.model}|${row.part}`;
    if (row.status === "ok" && chartKeys.has(key)) {
      if (!historyByKey.has(key)) historyByKey.set(key, []);
      historyByKey.get(key).push(row);
    }
  }
  const chartSeries = [...chartKeys.keys()]
    .map((key) => ({
      label: key.split("|").join(" - "),
      points: (historyByKey.get(key) || [])
        .filter((row) => row.price_value !== null)
        .map((row) => ({ date: row.date, value: row.price_value, price: money(row.price_value, row.currency) })),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const successfulRows = rows.filter((row) => row.status === "ok");
  const errorRows = rows.filter((row) => row.status !== "ok");
  const priced = latest.filter((row) => row.price_value !== null).map((row) => row.price_value);
  const today = localDay(new Date());
  const updatedToday = allLatest.filter((row) => localDay(row.date) === today).length;
  let chartNote = `Showing ${chartSeries.length} chart series`;
  if (latest.length > chartSeries.length) chartNote += ` from ${latest.length} matching prices. Search a model or spare part for a focused chart.`;

  if (!HISTORY_PER_PAGE_OPTIONS.includes(historyPerPage)) historyPerPage = HISTORY_PER_PAGE_DEFAULT;
  const historyPagination = pageInfo(rows.length, historyPage, historyPerPage);

  return {
    latest: pagedLatest,
    history: rows.slice(historyPagination.slice_start, historyPagination.slice_end),
    history_pagination: historyPagination,
    brands: cached.brands,
    per_page_options: PER_PAGE_OPTIONS,
    history_per_page_options: HISTORY_PER_PAGE_OPTIONS,
    suggestions: cached.suggestions,
    model_options: cached.model_options,
    sort, sort_dir: sortDir, selected_status: status, selected_brands: selectedBrands,
    pagination,
    chart_json: JSON.stringify(chartSeries),
    chart_note: chartNote,
    stats: {
      tracked: latest.length,
      brands: new Set(latest.map((row) => row.brand)).size,
      models: new Set(latest.map((row) => `${row.brand_key}|${row.model_key}`)).size,
      checks: rows.length,
      errors: errorRows.length,
      total_value: latest.reduce((sum, row) => sum + (row.price_value || 0), 0),
      average_value: priced.length ? priced.reduce((sum, value) => sum + value, 0) / priced.length : null,
      updated_today: updatedToday,
      last_success: successfulRows[0]?.date ?? null,
    },
    hosted_read_only: HOSTED_READ_ONLY,
    data_source: cached.source || "",
    remote_error: cached.remote_error || "",
  };
}

/** Rows for an export plus a short name for the file. */
export async function exportRows(scope, model, filters) {
  if (scope === "view") {
    const data = await loadDashboard({ search: filters.search, selectedBrands: filters.brands, status: filters.status, sort: "model", sortDir: "asc", paginate: false });
    return [data.latest.map((item) => item.row), "current_view"];
  }
  const data = await loadDashboard({ sort: "model", sortDir: "asc", paginate: false });
  const rows = data.latest.map((item) => item.row);
  if (scope !== "model" || !model.trim()) return [rows, "all_models"];
  const wanted = modelKey(model);
  const wantedLoose = modelKey(model, true);
  let chosen = rows.filter((row) => row.model_key === wanted);
  if (!chosen.length) chosen = rows.filter((row) => modelKey(row.model, true) === wantedLoose);
  if (!chosen.length) chosen = rows.filter((row) => matchesSearch(row, model));
  const label = cleanLabel(model).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "model";
  return [chosen, label];
}
