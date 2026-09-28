// Motorola India: one support article listing each model as an XT code
// heading followed by "Part: price" lines. (The page layout changed in
// September 2026 and currently yields no models; kept for when it is fixed.)
import { log } from "../../shared/log.js";
import { coercePriceValue, isNonSparePart, normalizeSpace, sleep } from "../../shared/text.js";
import { gotoCatalogPage, modelMatchesFilter } from "../browser.js";
import { saveCatalogError, saveStructuredPriceRows } from "../db.js";

export const MOTOROLA_URL = "https://en-in.support.motorola.com/app/answers/detail/a_id/133816";

export function motorolaPriceRows(text) {
  const rowsByModel = new Map();
  let modelName = null;
  const modelPattern = /^(XT[\w-]+\s+.+)$/i;
  const partPattern = /^([^:]{2,}):\s*(?:₹|Rs\.?\s*|INR\s*)?(\d[\d,]*(?:\.\d{1,2})?)\*?$/;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeSpace(rawLine);
    const modelMatch = modelPattern.exec(line);
    if (modelMatch) {
      modelName = modelMatch[1];
      if (!rowsByModel.has(modelName)) rowsByModel.set(modelName, []);
      continue;
    }
    if (!modelName) continue;
    const partMatch = partPattern.exec(line);
    if (!partMatch) continue;
    const part = partMatch[1];
    if (isNonSparePart(part)) continue;
    const priceValue = coercePriceValue(partMatch[2]);
    if (priceValue !== null) rowsByModel.get(modelName).push({ part, price_value: priceValue, currency: "INR" });
  }
  return new Map([...rowsByModel].filter(([, rows]) => rows.length));
}

export async function discoverMotorola(context, conn, delaySeconds, maxModels, modelFilter) {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  try {
    await gotoCatalogPage(page, MOTOROLA_URL);
    const catalog = motorolaPriceRows(await page.locator("body").innerText());
    const models = [...catalog.keys()].filter((model) => modelMatchesFilter(model, modelFilter));
    log.info(`Motorola mobile models found: ${models.length}`);
    let count = 0;
    for (const modelName of models) {
      count += 1;
      if (maxModels !== null && count > maxModels) return;
      const saved = saveStructuredPriceRows(conn, "Motorola", modelName, MOTOROLA_URL, catalog.get(modelName));
      if (!saved) {
        saveCatalogError(conn, "Motorola", modelName, MOTOROLA_URL, "No Motorola spare-part price rows found");
        continue;
      }
      log.info(`Discovered Motorola ${modelName} (${saved} rows, ${count}/${maxModels ?? "all"})`);
      if (count < models.length) await sleep(delaySeconds);
    }
  } catch (error) {
    log.exception("Motorola catalog discovery failed", error);
  } finally {
    await page.close();
  }
}
