// Samsung India: spare-part pricing list with a custom series/model picker.
import { log } from "../../shared/log.js";
import { cssEscape, normalizeSpace, parsePrice, sleep, utcNow } from "../../shared/text.js";
import { modelMatchesFilter, newCrawlContext } from "../browser.js";
import { saveResult } from "../db.js";

export const SAMSUNG_URL = "https://www.samsung.com/in/support/spare-part-pricing-list-for-repair/";
export const SAMSUNG_SERIES = [
  ["galaxy-z", "Galaxy Z Series"],
  ["galaxy-s", "Galaxy S Series"],
  ["galaxy-a", "Galaxy A Series"],
  ["galaxy-m", "Galaxy M Series"],
  ["galaxy-f", "Galaxy F Series"],
  ["galaxy-tab", "Galaxy Tab Series"],
];

export function parseSamsungRow(title, price) {
  let part = normalizeSpace(title.replace(/•/g, "-"));
  // FRAGILE SITE ASSUMPTION: storage-only rows are motherboard variants. The
  // amount must come only from .result-price, never the title.
  const storage = /^-?\s*(\d+\s*(?:GB|TB))$/i.exec(part);
  if (storage) part = `Motherboard - ${storage[1].toUpperCase()}`;
  const amount = normalizeSpace(price);
  if (/\d\s*(?:GB|TB)/i.test(amount)) throw new Error(`Storage label found in Samsung price cell: '${amount}'`);
  const [, value] = parsePrice(amount);
  return { part, priceText: `${part} ${amount}`, value };
}

async function waitIdle(page) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    // keep going with what has loaded
  }
}

async function loadSamsungModelsForSeries(page, seriesValue, seriesLabel) {
  // FRAGILE SITE ASSUMPTION: a custom dropdown whose visible cards and hidden
  // radio inputs must be in the right open/closed state.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.locator("a.select-series").click({ timeout: 5000 });
    } catch {
      // dropdown may already be open
    }
    try {
      const label = page.locator(".choose-smartphone-name").filter({ hasText: seriesLabel }).first();
      await label.scrollIntoViewIfNeeded({ timeout: 3000 });
      const box = await label.boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      else await page.locator(`input[name="series"][value="${seriesValue}"]`).click({ force: true });
      await page.waitForTimeout(1200);
      const modelValues = await page.locator('input[name="models"]').evaluateAll((inputs) => inputs.map((input) => input.value).filter(Boolean));
      if (!modelValues.length) {
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitIdle(page);
        continue;
      }
      return modelValues;
    } catch (error) {
      if (attempt === 1) log.exception(`Samsung series selection failed: ${seriesValue}`, error);
      else {
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitIdle(page);
      }
    }
  }
  return [];
}

export async function discoverSamsung(browser, conn, delaySeconds, maxModels, samsungSeries, modelFilter) {
  let seriesValues = SAMSUNG_SERIES;
  if (samsungSeries) seriesValues = seriesValues.filter(([value]) => value === samsungSeries);
  let count = 0;
  for (const [seriesValue, seriesLabel] of seriesValues) {
    const context = await newCrawlContext(browser);
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    try {
      await page.goto(SAMSUNG_URL, { waitUntil: "domcontentloaded" });
      await waitIdle(page);
      try {
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitIdle(page);
      } catch {
        // storage may be blocked
      }
      try {
        await page.getByText("Accept", { exact: true }).first().click({ timeout: 2000 });
      } catch {
        // no cookie banner
      }
      const modelValues = await loadSamsungModelsForSeries(page, seriesValue, seriesLabel);
      log.info(`Samsung ${seriesValue} models found: ${modelValues.length}`);
      if (!modelValues.length) continue;
      const seen = new Set();
      for (const modelValue of modelValues) {
        if (!modelMatchesFilter(modelValue, modelFilter) || seen.has(modelValue)) continue;
        seen.add(modelValue);
        if (maxModels !== null && count >= maxModels) return;
        try {
          await page.locator(`input[name="models"][value="${cssEscape(modelValue)}"]`).click({ force: true });
          await page.waitForTimeout(1600);
          const rows = await page.locator(".smartphone-detail-result-tr").evaluateAll((trs) =>
            trs.flatMap((tr) =>
              [...tr.querySelectorAll(".smartphone-detail-result-row")]
                .map((row) => {
                  const title = row.querySelector(".result-title")?.innerText?.trim();
                  const price = row.querySelector(".result-price")?.innerText?.trim();
                  return title && price ? { title, price } : null;
                })
                .filter(Boolean),
            ),
          );
          for (const row of rows) {
            const parsed = parseSamsungRow(row.title, row.price);
            const entry = { brand: "Samsung", model: modelValue, part: parsed.part, url: SAMSUNG_URL, currency: "INR" };
            saveResult(conn, entry, utcNow(), parsed.priceText, parsed.value, "INR", "ok");
          }
          count += 1;
          log.info(`Discovered Samsung ${modelValue} (${rows.length} rows, ${count}/${maxModels ?? "all"})`);
          await sleep(delaySeconds);
        } catch (error) {
          log.exception(`Samsung model discovery failed: ${modelValue}`, error);
        }
      }
    } catch (error) {
      log.exception(`Samsung catalog discovery failed for series: ${seriesValue}`, error);
    } finally {
      await page.close();
      await context.close();
    }
  }
}
