// Apple India: support.apple.com repair page with device/model dropdowns.
import { log } from "../../shared/log.js";
import { normalizeSpace, parsePrice, PRICE_RE, sleep, utcNow } from "../../shared/text.js";
import { modelMatchesFilter } from "../browser.js";
import { saveResult } from "../db.js";

export const APPLE_URL = "https://support.apple.com/en-in/iphone/repair?services=service";

/** Lines after "Estimated service cost": part, then a price line containing INR. */
export function parseAppleServicePrices(text) {
  const lines = text.split(/\r?\n/).map(normalizeSpace).filter(Boolean);
  const results = [];
  let serviceStarted = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === "Estimated service cost") {
      serviceStarted = true;
      continue;
    }
    if (serviceStarted && (line === "Get a service" || line === "Where can I get a service?")) break;
    if (!serviceStarted || PRICE_RE.test(line)) continue;
    if (index + 1 < lines.length && lines[index + 1].includes("INR")) {
      const priceLine = lines[index + 1];
      const [, value] = parsePrice(priceLine);
      if (value !== null) results.push({ part: line, priceText: `${line} ${priceLine}`, value });
    }
  }
  return results;
}

export async function discoverApple(context, conn, delaySeconds, maxModels, modelFilter) {
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  let count = 0;
  try {
    await page.goto(APPLE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    const deviceLabels = await page.locator("select.device-dropdown").first().evaluate((select) =>
      [...select.options].map((option) => option.textContent.trim()).filter(Boolean),
    );
    for (const deviceLabel of deviceLabels) {
      await page.locator("select.device-dropdown").first().selectOption({ label: deviceLabel });
      await page.waitForTimeout(1500);
      const modelLabels = await page.locator("select.model-dropdown").first().evaluate((select) =>
        [...select.options].map((option) => option.textContent.trim()).filter(Boolean),
      );
      for (const modelLabel of modelLabels) {
        if (!modelMatchesFilter(modelLabel, modelFilter)) continue;
        if (maxModels !== null && count >= maxModels) return;
        await page.locator("select.model-dropdown").first().selectOption({ label: modelLabel });
        await page.waitForTimeout(1500);
        const priceRows = parseAppleServicePrices(await page.locator("body").innerText());
        for (const row of priceRows) {
          const entry = { brand: "Apple", model: modelLabel, part: row.part, url: APPLE_URL, currency: "INR" };
          saveResult(conn, entry, utcNow(), row.priceText, row.value, "INR", "ok");
        }
        count += 1;
        log.info(`Discovered Apple ${modelLabel} (${priceRows.length} rows, ${count}/${maxModels ?? "all"})`);
        await sleep(delaySeconds);
      }
    }
  } catch (error) {
    log.exception("Apple catalog discovery failed", error);
  } finally {
    await page.close();
  }
}
