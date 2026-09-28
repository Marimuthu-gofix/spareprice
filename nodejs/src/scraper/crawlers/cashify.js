// Cashify: prices through the site's own JSON API. One page load captures the
// bearer token the site's scripts send (cached on disk for the hour it
// lasts); after that every model list and price is a small JSON call, so no
// browser page is rendered per model. Falls back to driving the pages if the
// API changes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { log } from "../../shared/log.js";
import { coercePriceValue, findCurrencyPriceMatch, isNonSparePart, normalizeSpace, sleep } from "../../shared/text.js";
import { gotoCatalogPage, modelMatchesFilter } from "../browser.js";
import { errorMessage, saveCatalogError, saveStructuredPriceRows } from "../db.js";

export const CASHIFY_REPAIR_URL = "https://www.cashify.in/repair";
const CASHIFY_API = "https://www.cashify.in/api";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const TOKEN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".cashify_token.json");

// Cashify prices and availability depend on the chosen city, which the site
// keeps in two cookies. Values were read from the site after picking the city.
export const CASHIFY_CITIES = {
  chennai: { ri: 333, rn: "Chennai", dp: 600027, seo: "chennai" },
  gurgaon: { ri: 249, rn: "Gurgaon", dp: 122001, seo: "gurgaon" },
};
export const DEFAULT_CASHIFY_CITY = "chennai";
export const activeCity = { ...CASHIFY_CITIES[DEFAULT_CASHIFY_CITY] };

// Words in a model name that identify its Cashify brand page.
const MODEL_BRAND_HINTS = {
  iphone: "apple", galaxy: "samsung", pixel: "google", redmi: "xiaomi", poco: "poco", narzo: "realme", nord: "oneplus",
  "moto ": "motorola", moto: "motorola", "edge ": "motorola", reno: "oppo", "find ": "oppo", iqoo: "iqoo", nothing: "nothing",
  infinix: "infinix", honor: "honor", nokia: "nokia", asus: "asus", "rog ": "asus", vivo: "vivo", xiaomi: "xiaomi",
  realme: "realme", oneplus: "oneplus", oppo: "oppo", samsung: "samsung", apple: "apple", google: "google", motorola: "motorola",
};
const BRAND_LABELS = {
  apple: "Apple", asus: "Asus", google: "Google", honor: "Honor", infinix: "Infinix", iqoo: "iQOO", motorola: "Motorola",
  nokia: "Nokia", nothing: "Nothing", oneplus: "OnePlus", oppo: "OPPO", poco: "POCO", realme: "realme", samsung: "Samsung",
  vivo: "vivo", xiaomi: "Xiaomi",
};
const SERVICE_ACRONYMS = new Set(["LCD", "OLED", "AMOLED", "USB", "SIM", "5G", "4G", "IMEI"]);
const SERVICE_RENAMES = { "motherboard inspection charges": "Motherboard Inspection" };

export function cashifyCityCookies(city) {
  const key = normalizeSpace(city || "").toLowerCase();
  const info = CASHIFY_CITIES[key];
  if (!info) throw new Error(`Unknown Cashify city '${city}'; choose from: ${Object.keys(CASHIFY_CITIES).sort().join(", ")}`);
  Object.assign(activeCity, info);
  const cityInfo = { ri: info.ri, rn: info.rn, dp: info.dp, isp: "1", xmd: 1, cs: [1], pt: ["csh"], rcy: 1, seo: info.seo, id: false };
  const common = { domain: ".cashify.in", path: "/", secure: true, sameSite: "Lax" };
  return [
    { name: "_cs__city-info__v1", value: encodeURIComponent(JSON.stringify(cityInfo)), ...common },
    { name: "_cs__pc__v1", value: String(info.dp), ...common },
  ];
}

export function cashifyBrandName(url) {
  const slug = url.replace(/\/+$/, "").split("/").pop().toLowerCase();
  return BRAND_LABELS[slug] || slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "CHARGING JACK" -> "Charging Jack", matching how the site shows it. */
export function cashifyServiceName(raw) {
  const cleaned = normalizeSpace(raw || "");
  const renamed = SERVICE_RENAMES[cleaned.toLowerCase()];
  if (renamed) return renamed;
  return cleaned
    .split(" ")
    .map((word) => {
      const bare = word.replace(/^\(+|\)+$/g, "");
      if (SERVICE_ACRONYMS.has(bare.toUpperCase())) return word.toUpperCase();
      const index = word.search(/[A-Za-z]/);
      if (index === -1) return word;
      return word.slice(0, index) + word[index].toUpperCase() + word.slice(index + 1).toLowerCase();
    })
    .join(" ");
}

export function cashifyQuoteUrl(entry) {
  // FRAGILE SITE ASSUMPTION: the URL Cashify navigates to when a model card is
  // clicked and the first colour is chosen.
  return `${CASHIFY_REPAIR_URL}/user/order/quote?` + new URLSearchParams(entry).toString();
}

class TokenRejected extends Error {}

async function apiPost(route, body, token) {
  const headers = { "content-type": "application/json", accept: "application/json", "x-app-installer": "cashify", "user-agent": USER_AGENT };
  if (token) headers["x-authorization"] = token;
  const response = await fetch(`${CASHIFY_API}/${route}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  if (response.status === 401) throw new TokenRejected("Cashify API token was rejected");
  if (!response.ok) throw new Error(`POST ${route} failed with HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

function tokenExpiry(token) {
  try {
    const payload = token.replace("Bearer ", "").split(".")[1];
    return Number(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp || 0);
  } catch {
    return 0;
  }
}

function loadCachedToken() {
  try {
    const token = String(JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")).token || "");
    if (token && tokenExpiry(token) - Date.now() / 1000 > 600) return token;
  } catch {
    // no usable cache
  }
  return null;
}

function saveCachedToken(token) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, exp: tokenExpiry(token) }));
  } catch {
    log.debug("Could not cache the Cashify token");
  }
}

/** Load one Cashify page in the browser and take the bearer token its own scripts send. */
async function captureToken(getContext) {
  const context = await getContext();
  const page = await context.newPage();
  let token = null;
  page.on("request", (request) => {
    const value = request.headers()["x-authorization"];
    if (value && request.url().includes("/api/") && !token) token = value;
  });
  try {
    await gotoCatalogPage(page, CASHIFY_REPAIR_URL);
    for (let i = 0; i < 10 && !token; i++) await page.waitForTimeout(500);
  } finally {
    await page.close();
  }
  if (token) {
    saveCachedToken(token);
    const expires = tokenExpiry(token);
    if (expires) log.info(`Cashify API token captured, valid for ${Math.max(0, (expires - Date.now() / 1000) / 3600).toFixed(0)} hours`);
  }
  return token;
}

async function brandUrlsFromHtml() {
  const response = await fetch(CASHIFY_REPAIR_URL, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(45000) });
  const html = await response.text();
  const slugs = new Set([...html.matchAll(/href="\/repair\/([a-z0-9-]+)"/g)].map((match) => match[1]));
  return [...slugs].sort().map((slug) => `https://www.cashify.in/repair/${slug}`);
}

/** Only the brand pages a model filter can match ("iPhone 17e" -> Apple). */
export function cashifyBrandsForFilter(brandUrls, modelFilter) {
  if (!modelFilter) return brandUrls;
  const requested = modelFilter.toLowerCase();
  const wanted = new Set(brandUrls.map((url) => cashifyBrandName(url).toLowerCase()).filter((name) => requested.includes(name)));
  for (const [keyword, hinted] of Object.entries(MODEL_BRAND_HINTS)) if (requested.includes(keyword)) wanted.add(hinted);
  const matching = brandUrls.filter((url) => wanted.has(cashifyBrandName(url).toLowerCase()));
  if (matching.length) log.info(`Cashify brands matching '${modelFilter}': ${[...wanted].sort().join(", ")}`);
  return matching.length ? matching : brandUrls;
}

/** Every model on a brand page, including the ones behind the series tabs. */
async function listModels(seo, token) {
  const models = [];
  let offset = 0;
  for (;;) {
    const body = { serid: 1, souid: 1, plid: 20, bid: null, pcid: null, ps: 500, os: offset, pin: activeCity.dp, regid: activeCity.ri, fid: null, pid: null, seo };
    const data = await apiPost(`pd01/v1/product-search-template?key=sp_parent_product&seo=${encodeURIComponent(seo)}`, body, token);
    const items = data.dt || [];
    const imageBase = String(data.piu || "");
    for (const item of items) {
      const colours = item.specs?.color || [];
      const first = colours[0] && typeof colours[0] === "object" ? colours[0] : {};
      if (!item.pi || !item.bid || !first.id) continue;
      models.push({
        bid: item.bid, bn: item.bn || "", pid: item.pi, plid: item.pli || 20, pn: normalizeSpace(String(item.pn || "")),
        pcid: first.id, pcn: first.dval || "", cdn: imageBase, in: item.pin || "",
      });
    }
    offset += items.length;
    if (!items.length || offset >= Number(data.hits || 0)) return models;
  }
}

async function modelPrices(entry, token) {
  const body = { plid: entry.plid, bid: entry.bid, pid: entry.pid, pcid: entry.pcid, ri: activeCity.ri, pin: activeCity.dp };
  const data = await apiPost("sp01/v3/services-available", body, token);
  const rows = [];
  for (const item of data.dt || []) {
    const name = cashifyServiceName(String(item.stn || ""));
    const price = coercePriceValue(item.cp);
    if (name && price !== null) rows.push({ part: `Cashify - ${name}`, price_value: price, currency: "INR" });
  }
  return rows;
}

export async function discoverCashify(getContext, conn, delaySeconds, maxModels, modelFilter) {
  let token = loadCachedToken();
  if (token) log.info("Using the cached Cashify API token");
  else {
    try {
      token = await captureToken(getContext);
    } catch (error) {
      log.exception("Could not load Cashify to capture its API token", error);
    }
  }
  if (!token) {
    log.warn("Cashify API token not found; falling back to page-driven discovery");
    await discoverCashifyBrowser(await getContext(), conn, delaySeconds, maxModels, modelFilter);
    return;
  }
  log.info(`Cashify prices are being read for pincode ${activeCity.dp} via the site API`);
  let brandUrls = [];
  try {
    brandUrls = await brandUrlsFromHtml();
  } catch (error) {
    log.exception("Could not read Cashify's brand list", error);
  }
  brandUrls = cashifyBrandsForFilter(brandUrls, modelFilter);
  log.info(`Cashify repair brands found: ${brandUrls.length}`);
  let count = 0;
  for (const brandUrl of brandUrls) {
    const brand = cashifyBrandName(brandUrl);
    const exactBrandFilter = Boolean(modelFilter && modelFilter.trim().toLowerCase() === brand.toLowerCase());
    const seo = "/repair/" + brandUrl.replace(/\/+$/, "").split("/").pop();
    let models;
    try {
      models = await listModels(seo, token);
    } catch (error) {
      if (error instanceof TokenRejected) {
        log.info("Cashify API token was rejected; capturing a fresh one");
        token = await captureToken(getContext);
        if (!token) {
          log.warn("Cashify API token expired and could not be renewed; stopping");
          return;
        }
        models = await listModels(seo, token);
      } else {
        log.exception(`Cashify model list failed for ${brand}`, error);
        saveCatalogError(conn, brand, `Cashify ${brand}`, brandUrl, errorMessage(error));
        continue;
      }
    }
    log.info(`Cashify ${brand} mobile models found: ${models.length}`);
    for (const entry of models) {
      const modelName = entry.pn;
      if (!modelName || (!exactBrandFilter && !modelMatchesFilter(modelName, modelFilter))) continue;
      if (maxModels !== null && count >= maxModels) return;
      const quoteUrl = cashifyQuoteUrl(entry);
      try {
        const saved = saveStructuredPriceRows(conn, brand, modelName, quoteUrl, await modelPrices(entry, token));
        if (!saved) {
          log.info(`Cashify has no published repair-service prices for ${modelName}`);
          continue;
        }
        count += 1;
        log.info(`Discovered Cashify ${brand} ${modelName} (${saved} rows, ${count}/${maxModels ?? "all"})`);
        await sleep(delaySeconds);
      } catch (error) {
        log.exception(`Cashify model discovery failed: ${modelName}`, error);
        saveCatalogError(conn, brand, `Cashify ${modelName}`, quoteUrl, errorMessage(error));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fallback: drive the pages (brand page, series tabs, quote page) as before.

export function cashifyPriceRows(text) {
  const lines = text.split(/\r?\n/).map(normalizeSpace).filter(Boolean);
  const start = lines.indexOf("Pick Your Repair Service") + 1;
  if (start === 0) return [];
  let end = lines.indexOf("Looking for other repair service?", start);
  if (end === -1) end = lines.length;
  const rows = [];
  const seen = new Set();
  for (let index = start; index < end - 1; index++) {
    const part = lines[index];
    if (!part || findCurrencyPriceMatch(part) || isNonSparePart(part)) continue;
    const priceMatch = /^(?:₹|Rs\.?\s*|INR\s*)(\d[\d,]*(?:\.\d{1,2})?)$/.exec(lines[index + 1]);
    if (!priceMatch) continue;
    const normalized = part.toLowerCase();
    if (seen.has(normalized)) continue;
    const priceValue = coercePriceValue(priceMatch[1]);
    if (priceValue !== null) {
      rows.push({ part, price_value: priceValue, currency: "INR" });
      seen.add(normalized);
    }
  }
  return rows;
}

async function seriesLabels(page) {
  const labels = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll("li")]
      .filter((item) => /series$/i.test(item.textContent.trim()) && item.getBoundingClientRect().height > 0)
      .map((item) => item.textContent.trim()))],
  );
  return labels.map((label) => normalizeSpace(label)).filter(Boolean);
}

async function selectSeries(page, label) {
  const clicked = await page.evaluate((wanted) => {
    const item = [...document.querySelectorAll("li")].find((li) => li.textContent.trim() === wanted && li.getBoundingClientRect().height > 0);
    if (!item) return false;
    (item.querySelector(".cursor-pointer") || item).click();
    return true;
  }, label);
  if (clicked) await page.waitForTimeout(1500);
  return clicked;
}

async function loadAllModelCards(page) {
  const selector = 'a[href*="/repair/"]';
  let stableRounds = 0;
  let previousCount = -1;
  for (let i = 0; i < 20; i++) {
    const currentCount = await page.locator(selector).count();
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
    const nextCount = await page.locator(selector).count();
    if (nextCount === currentCount && currentCount === previousCount) {
      stableRounds += 1;
      if (stableRounds >= 2) break;
    } else stableRounds = 0;
    previousCount = nextCount;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

function modelCardNames(page) {
  return page.locator('.cursor-pointer img[src*="/product/"][alt]').evaluateAll((images) =>
    [...new Set(images.map((image) => image.alt.trim()).filter(Boolean))],
  );
}

function collectCatalog(data, catalog) {
  if (!data || typeof data !== "object") return;
  const imageBase = String(data.piu || "");
  for (const item of data.dt || []) {
    if (!item || typeof item !== "object") continue;
    const name = normalizeSpace(String(item.pn || ""));
    const first = (item.specs?.color || [])[0] || {};
    if (!name || !item.pi || !item.bid || !first.id) continue;
    if (!catalog.has(name)) {
      catalog.set(name, { bid: item.bid, bn: item.bn || "", pid: item.pi, plid: item.pli || 20, pn: name, pcid: first.id, pcn: first.dval || "", cdn: imageBase, in: item.pin || "" });
    }
  }
}

export async function discoverCashifyBrowser(context, conn, delaySeconds, maxModels, modelFilter) {
  let page = await context.newPage();
  page.setDefaultTimeout(45000);
  let count = 0;
  try {
    await gotoCatalogPage(page, CASHIFY_REPAIR_URL);
    const pincode = await page.evaluate(() => (document.cookie.match(/_cs__pc__v1=(\d+)/) || [])[1] || "");
    log.info(`Cashify prices are being read for pincode ${pincode || "unknown"}`);
    let brandUrls = await page.locator('a[href*="/repair/"]').evaluateAll((anchors) =>
      [...new Set(anchors.map((anchor) => anchor.href))].filter((href) => /^https:\/\/www\.cashify\.in\/repair\/[^/?#]+\/?$/.test(href)),
    );
    brandUrls = cashifyBrandsForFilter(brandUrls, modelFilter);
    log.info(`Cashify repair brands found: ${brandUrls.length}`);
    for (const [brandIndex, brandUrl] of brandUrls.entries()) {
      if (brandIndex) {
        await page.close();
        page = await context.newPage();
        page.setDefaultTimeout(45000);
      }
      const brand = cashifyBrandName(brandUrl);
      const exactBrandFilter = Boolean(modelFilter && modelFilter.trim().toLowerCase() === brand.toLowerCase());
      const catalog = new Map();
      const pending = [];
      const capture = (response) => {
        if (response.url().includes("product-search-template") && response.ok()) {
          pending.push(response.json().then((data) => collectCatalog(data, catalog)).catch(() => {}));
        }
      };
      page.on("response", capture);
      const modelSeries = new Map();
      let labels = [];
      try {
        await gotoCatalogPage(page, brandUrl);
        labels = await seriesLabels(page);
        for (const label of [null, ...labels]) {
          if (label !== null) {
            await gotoCatalogPage(page, brandUrl);
            if (!(await selectSeries(page, label))) {
              log.warn(`Cashify ${brand} series tab was not found: ${label}`);
              continue;
            }
          }
          await loadAllModelCards(page);
          for (const name of await modelCardNames(page)) if (!modelSeries.has(name)) modelSeries.set(name, label);
        }
        await Promise.allSettled(pending);
      } finally {
        page.off("response", capture);
      }
      for (const name of catalog.keys()) if (!modelSeries.has(name)) modelSeries.set(name, null);
      log.info(`Cashify ${brand} mobile models found: ${modelSeries.size} across ${labels.length} series (${catalog.size} with direct quote links)`);
      for (const [rawName, label] of modelSeries) {
        const modelName = normalizeSpace(rawName);
        if (!modelName || (!exactBrandFilter && !modelMatchesFilter(modelName, modelFilter))) continue;
        if (maxModels !== null && count >= maxModels) return;
        try {
          const entry = catalog.get(modelName);
          if (entry) {
            await page.goto(cashifyQuoteUrl(entry), { waitUntil: "domcontentloaded", timeout: 60000 });
          } else {
            await gotoCatalogPage(page, brandUrl);
            if (label !== null && !(await selectSeries(page, label))) throw new Error(`Cashify series tab was not found: ${label}`);
            await loadAllModelCards(page);
            const card = page.locator(`.cursor-pointer img[src*="/product/"][alt="${modelName.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`).first();
            if (!(await card.count())) throw new Error("Cashify model card was not found after loading the brand page");
            await card.click();
            await page.waitForURL("**/repair/user/order/quote?**", { timeout: 15000 });
          }
          await page.getByRole("heading", { name: "Pick Your Repair Service", exact: true }).waitFor({ state: "visible", timeout: 20000 });
          const rows = cashifyPriceRows(await page.locator("body").innerText()).map((row) => ({ ...row, part: `Cashify - ${row.part}` }));
          const saved = saveStructuredPriceRows(conn, brand, modelName, page.url(), rows);
          if (!saved) {
            log.info(`Cashify has no published repair-service prices for ${modelName}`);
            continue;
          }
          count += 1;
          log.info(`Discovered Cashify ${brand} ${modelName} (${saved} rows, ${count}/${maxModels ?? "all"})`);
          await sleep(delaySeconds);
        } catch (error) {
          log.exception(`Cashify model discovery failed: ${modelName}`, error);
          saveCatalogError(conn, brand, `Cashify ${modelName}`, brandUrl, errorMessage(error));
        }
      }
    }
  } catch (error) {
    log.exception("Cashify catalog discovery failed", error);
  } finally {
    await page.close();
  }
}
