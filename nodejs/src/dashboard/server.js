// The dashboard web app (Express + Nunjucks). Ported from dashboard.py.
//
//   node src/dashboard/server.js          -> http://127.0.0.1:5000
//   PORT=10000 node src/dashboard/server.js
import path from "node:path";

import express from "express";
import nunjucks from "nunjucks";

import { log } from "../shared/log.js";
import {
  exportRows, HISTORY_PER_PAGE_DEFAULT, HOSTED_READ_ONLY, loadDashboard, loadPriceData, localDate, money, ROOT,
} from "./data.js";
import { rowsToCsv, rowsToExcel } from "./exports.js";
import { currentJobState, SCRAPE_BRANDS, startJob } from "./jobs.js";

const ICONS = {
  refresh: '<path d="M3 12a9 9 0 0 1 15.3-6.4M21 12a9 9 0 0 1-15.3 6.4"/><path d="M3 3v5h5M21 21v-5h-5"/>',
  download: '<path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M4 19h16"/>',
  dot: '<circle cx="12" cy="12" r="5"/>',
  play: '<path d="M6 4l14 8-14 8V4z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  "search-sm": '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.5"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  tag: '<path d="M20 12 12.5 19.5a2 2 0 0 1-2.8 0l-6.2-6.2a2 2 0 0 1 0-2.8L11 3h9v9Z"/><circle cx="15" cy="8" r="1.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  empty: '<path d="M4 7h16l-1.5 12.5a2 2 0 0 1-2 1.8H7.5a2 2 0 0 1-2-1.8L4 7Z"/><path d="M9 7V5a3 3 0 0 1 6 0v2"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  alert: '<path d="M12 3 2 21h20L12 3Z"/><path d="M12 10v4M12 17h.01"/>',
  asc: '<path d="m6 15 6-6 6 6"/>',
  desc: '<path d="m6 9 6 6 6-6"/>',
  "sort-none": '<path d="m8 9 4-4 4 4M8 15l4 4 4-4" opacity="0.4"/>',
};

function icon(name) {
  const body = ICONS[name] || ICONS.dot;
  return new nunjucks.runtime.SafeString(
    `<svg class="icon icon-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`,
  );
}

const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false }));
app.use("/static", express.static(path.join(ROOT, "public"), { maxAge: "1h" }));

const env = nunjucks.configure(path.join(ROOT, "views"), { autoescape: true, express: app, noCache: Boolean(process.env.TEMPLATE_RELOAD) });
env.addFilter("money", money);
env.addFilter("localdate", localDate);
env.addGlobal("icon", icon);

// ------------------------------------------------------------ helpers
function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseFilters(query) {
  const raw = query.brand === undefined ? [] : Array.isArray(query.brand) ? query.brand : [query.brand];
  const brands = [];
  for (const value of raw) {
    const cleaned = String(value).trim();
    if (cleaned && !brands.includes(cleaned)) brands.push(cleaned);
  }
  return {
    search: String(query.q ?? "").trim(),
    brands,
    status: String(query.status ?? "").trim(),
    page: positiveInt(query.page, 1),
    per_page: positiveInt(query.per_page, 100),
    history_page: positiveInt(query.hpage, 1),
    history_per_page: positiveInt(query.hper_page, HISTORY_PER_PAGE_DEFAULT),
    sort: String(query.sort ?? "date").trim() || "date",
    sort_dir: String(query.dir ?? "desc").trim() || "desc",
  };
}

/** Base query (no page) for sort/export links; pass overrides such as page. */
function buildQuery(filters, overrides = {}) {
  return {
    q: filters.search, brand: filters.brands, status: filters.status, per_page: filters.per_page,
    hper_page: filters.history_per_page, hpage: filters.history_page, sort: filters.sort, dir: filters.sort_dir, ...overrides,
  };
}

/** Like Flask's url_for: lists repeat the key, empty values are dropped, `_anchor` becomes a fragment. */
function urlFor(pathname, params = {}) {
  const search = new URLSearchParams();
  let anchor = "";
  for (const [key, value] of Object.entries(params)) {
    if (key === "_anchor") {
      anchor = value ? `#${value}` : "";
      continue;
    }
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((item) => search.append(key, String(item)));
    else search.append(key, String(value));
  }
  const text = search.toString();
  return pathname + (text ? `?${text}` : "") + anchor;
}

function buildActiveFilters(filters) {
  const active = [];
  if (filters.search) active.push({ label: `Search "${filters.search}"`, remove_url: urlFor("/", buildQuery(filters, { q: "", page: 1 })) });
  for (const selected of filters.brands) {
    active.push({ label: selected, remove_url: urlFor("/", buildQuery(filters, { brand: filters.brands.filter((b) => b !== selected), page: 1 })) });
  }
  if (filters.status === "ok" || filters.status === "error") {
    active.push({ label: filters.status === "ok" ? "Available" : "Error", remove_url: urlFor("/", buildQuery(filters, { status: "", page: 1 })) });
  }
  return active;
}

function pagerLinks(pagination, query, pageParam, anchor) {
  const link = (page) => urlFor("/", { ...query, [pageParam]: page, ...(anchor ? { _anchor: anchor } : {}) });
  const pages = pagination.page_numbers.map((number, index, all) => ({
    number, url: link(number), current: number === pagination.page, gap: index > 0 && number !== all[index - 1] + 1,
  }));
  return {
    first: link(1), prev: link(pagination.prev_page), next: link(pagination.next_page), last: link(pagination.total_pages), pages,
  };
}

function sortHeaders(filters) {
  return [["brand", "Brand"], ["model", "Model"], ["part", "Spare Part"], ["price", "Latest Price"], ["date", "Last Checked"]].map(([key, label]) => {
    const active = filters.sort === key;
    const nextDir = active && filters.sort_dir === "desc" ? "asc" : "desc";
    return {
      key, label, active,
      url: urlFor("/", { sort: key, dir: nextDir, q: filters.search, brand: filters.brands, status: filters.status, per_page: filters.per_page, page: 1 }),
      icon: active ? (filters.sort_dir === "asc" ? "asc" : "desc") : "sort-none",
    };
  });
}

function wantsJson(req) {
  return req.get("Accept") === "application/json";
}

function hostedReadOnly(req, res) {
  const payload = currentJobState();
  payload.message = "Hosted dashboard is read-only";
  payload.output = "Run the scraper locally and push the updated database to refresh this view.";
  if (wantsJson(req)) return res.status(409).json(payload);
  return res.redirect("/");
}

// ------------------------------------------------------------- routes
app.get("/", async (req, res, next) => {
  try {
    const filters = parseFilters(req.query);
    const data = await loadDashboard({
      search: filters.search, selectedBrands: filters.brands, page: filters.page, perPage: filters.per_page, status: filters.status,
      sort: filters.sort, sortDir: filters.sort_dir, historyPage: filters.history_page, historyPerPage: filters.history_per_page,
    });
    const baseQuery = buildQuery(filters);
    const historyQuery = buildQuery(filters, { page: data.pagination.page });
    delete historyQuery.hpage;
    res.render("dashboard.html", {
      ...data,
      job: currentJobState(),
      search: filters.search,
      selected_per_page: data.pagination.per_page,
      active_filters: buildActiveFilters(filters),
      sort_headers: sortHeaders(filters),
      latest_links: pagerLinks(data.pagination, baseQuery, "page", ""),
      history_links: pagerLinks(data.history_pagination, historyQuery, "hpage", "recent-checks"),
      urls: {
        index: "/",
        css: "/static/dashboard.css",
        js: "/static/dashboard.js",
        models_json: "/models.json",
        export_all: urlFor("/export.xlsx", { scope: "all" }),
        export_view: urlFor("/export.xlsx", { scope: "view", ...baseQuery }),
        export_base: "/export.xlsx",
        check_now: "/check-now",
        discover_scope: "/discover-scope",
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/models.json", async (req, res, next) => {
  try {
    res.json((await loadPriceData()).model_options);
  } catch (error) {
    next(error);
  }
});

app.get("/export.csv", async (req, res, next) => {
  try {
    const [rows, label] = await exportRows(String(req.query.scope ?? "view"), String(req.query.model ?? ""), parseFilters(req.query));
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename=spareprice_${label}.csv`);
    res.send(rowsToCsv(rows));
  } catch (error) {
    next(error);
  }
});

app.get("/export.xlsx", async (req, res, next) => {
  try {
    const [rows, label] = await exportRows(String(req.query.scope ?? "all"), String(req.query.model ?? ""), parseFilters(req.query));
    res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.set("Content-Disposition", `attachment; filename=spareprice_${label}.xlsx`);
    res.send(await rowsToExcel(rows));
  } catch (error) {
    next(error);
  }
});

app.post("/check-now", (req, res) => {
  if (HOSTED_READ_ONLY) return hostedReadOnly(req, res);
  const started = startJob("shortlist");
  if (wantsJson(req)) return res.status(started ? 202 : 409).json(currentJobState());
  return res.redirect("/");
});

app.post("/discover-all", (req, res) => {
  if (HOSTED_READ_ONLY) return hostedReadOnly(req, res);
  const started = startJob("catalog", "all", "");
  if (wantsJson(req)) return res.status(started ? 202 : 409).json(currentJobState());
  return res.redirect("/");
});

app.post("/discover-scope", (req, res) => {
  if (HOSTED_READ_ONLY) return hostedReadOnly(req, res);
  let brand = String(req.body?.scrape_brand ?? "").trim().toLowerCase() || "all";
  const model = String(req.body?.scrape_model ?? "").trim();
  if (!SCRAPE_BRANDS.has(brand)) brand = "all";
  const started = startJob("catalog", brand, model);
  if (wantsJson(req)) return res.status(started ? 202 : 409).json(currentJobState());
  return res.redirect("/");
});

app.get("/job-status", (req, res) => res.json(currentJobState()));

app.use((error, req, res, _next) => {
  log.exception(`Request failed: ${req.method} ${req.originalUrl}`, error);
  res.status(500).send("Dashboard error: " + error.message);
});

export { app };

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const port = Number(argValue("--port") || process.env.PORT || 5000);
const host = argValue("--host") || process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  app.listen(port, host, () => log.info(`Dashboard listening on http://${host}:${port}`));
  // Warm the cache so the first visitor does not wait.
  loadPriceData().catch((error) => log.exception("Could not warm the price data cache", error));
}
