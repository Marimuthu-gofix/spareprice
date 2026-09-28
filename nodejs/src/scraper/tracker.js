// The config.json shortlist: `run` scrapes every enabled entry with its
// recorded browser actions; `dry-run` does the same in a visible browser
// without saving. Ported from run_tracker / dry_run / scrape_entry.
import fs from "node:fs";

import { chromium } from "playwright";

import { log } from "../shared/log.js";
import { normalizeSpace, parsePrice, PRICE_RE, sleep, utcNow } from "../shared/text.js";
import { browserLaunchArgs, dismissCommonPopups } from "./browser.js";
import { connectDb, defaultDbPath, errorMessage, saveResult } from "./db.js";
import { flushRemoteStore } from "./discover.js";

export function loadConfig(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function required(mapping, key) {
  const value = mapping[key];
  if (!value) throw new Error(`Missing required config field: ${key}`);
  return String(value);
}

export function enabledEntries(config) {
  return (config.entries || [])
    .filter((raw) => raw.enabled !== false)
    .map((raw) => ({
      brand: required(raw, "brand"),
      model: required(raw, "model"),
      part: required(raw, "part"),
      url: required(raw, "url"),
      currency: raw.currency ?? null,
      actions: [...(raw.actions || [])],
      priceSelector: required(raw, "price_selector"),
    }));
}

async function performAction(page, action) {
  const force = Boolean(action.force);
  switch (action.type) {
    case "click":
      await page.locator(required(action, "selector")).first().click({ force });
      break;
    case "click_text":
      await page.getByText(required(action, "text"), { exact: Boolean(action.exact) }).first().click({ force });
      break;
    case "fill": {
      const locator = page.locator(required(action, "selector")).first();
      await locator.fill(String(action.value ?? ""));
      if (action.press) await locator.press(String(action.press));
      break;
    }
    case "select_option": {
      const locator = page.locator(required(action, "selector")).first();
      if ("label" in action) await locator.selectOption({ label: String(action.label) });
      else if ("value" in action) await locator.selectOption({ value: String(action.value) });
      else if ("index" in action) await locator.selectOption({ index: Number(action.index) });
      else throw new Error("select_option action requires label, value, or index");
      break;
    }
    case "wait_for_selector":
      await page.locator(required(action, "selector")).first().waitFor({ state: action.state || "visible" });
      break;
    case "wait_for_timeout":
      await page.waitForTimeout(Number(action.ms ?? 1000));
      break;
    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }
}

function extractRelevantPriceText(text, part) {
  const lines = text.split(/\r?\n/).map(normalizeSpace).filter(Boolean);
  const partLower = part.toLowerCase();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.toLowerCase().includes(partLower) && PRICE_RE.test(line)) return line;
    if (line.toLowerCase().includes(partLower)) {
      for (const nearby of lines.slice(index + 1, index + 5)) if (PRICE_RE.test(nearby)) return `${line} ${nearby}`;
    }
  }
  for (const line of lines) if (PRICE_RE.test(line)) return line;
  return normalizeSpace(text);
}

async function scrapeEntry(page, entry) {
  await page.goto(entry.url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  await dismissCommonPopups(page);
  // FRAGILE SITE ASSUMPTION: every action depends on the current page labels
  // and selectors; update config.json before changing code.
  for (const action of entry.actions) {
    await performAction(page, action);
    await page.waitForTimeout(Number(action.post_delay_ms ?? 1000));
  }
  const locator = page.locator(entry.priceSelector).first();
  await locator.waitFor({ state: "visible" });
  const text = await locator.innerText();
  if (!PRICE_RE.test(text)) throw new Error(`Price selector matched text without a parseable amount: ${text.slice(0, 300)}`);
  return extractRelevantPriceText(text, entry.part);
}

export async function runTracker(configPath) {
  const config = loadConfig(configPath);
  const dbPath = defaultDbPath(config.database_path || "price_history.sqlite3");
  const delaySeconds = Number(config.delay_seconds ?? 6);
  const timeoutMs = Number(config.timeout_ms ?? 45000);
  const headless = config.headless !== false;
  const entries = enabledEntries(config);
  const conn = connectDb(dbPath);
  const browser = await chromium.launch({ headless, args: browserLaunchArgs() });
  const context = await browser.newContext({
    locale: "en-IN",
    viewport: { width: 1366, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  try {
    for (const [index, entry] of entries.entries()) {
      const timestamp = utcNow();
      log.info(`Checking ${index + 1}/${entries.length}: ${entry.model} - ${entry.part}`);
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      try {
        const priceText = await scrapeEntry(page, entry);
        const [parsedCurrency, priceValue] = parsePrice(priceText);
        saveResult(conn, entry, timestamp, priceText, priceValue, parsedCurrency || entry.currency, "ok");
        log.info(`Saved ${entry.brand} ${entry.model} ${entry.part}: ${priceText}`);
      } catch (error) {
        log.exception(`Failed ${entry.brand} ${entry.model} ${entry.part}; storing error and continuing`, error);
        saveResult(conn, entry, timestamp, null, null, entry.currency, "error", errorMessage(error));
      } finally {
        await page.close();
      }
      if (index + 1 < entries.length) await sleep(delaySeconds);
    }
  } finally {
    await context.close();
    await browser.close();
    conn.close();
  }
  await flushRemoteStore();
  return 0;
}

export async function dryRun(configPath) {
  const config = loadConfig(configPath);
  const timeoutMs = Number(config.timeout_ms ?? 45000);
  const entries = enabledEntries(config);
  const browser = await chromium.launch({ headless: false, args: browserLaunchArgs() });
  const context = await browser.newContext({ locale: "en-IN", viewport: { width: 1366, height: 900 } });
  try {
    for (const entry of entries) {
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      try {
        log.info(`DRY RUN ok: ${entry.brand} ${entry.model} ${entry.part} => ${await scrapeEntry(page, entry)}`);
      } catch (error) {
        log.exception(`DRY RUN failed: ${entry.brand} ${entry.model} ${entry.part}`, error);
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
  return 0;
}
