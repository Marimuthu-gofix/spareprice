// Xiaomi India: model and part data from in-go.buy.mi.com with the public
// Basic auth value embedded in the page bundle.
import { log } from "../../shared/log.js";
import { normalizeSpace, sleep } from "../../shared/text.js";
import { apiGetJson, modelMatchesFilter } from "../browser.js";
import { errorMessage, saveCatalogError, saveStructuredPriceRows } from "../db.js";

export const MI_URL = "https://www.mi.com/in/support/spare-part-prices/model?category=Mobile";
const MI_API_BASE = "https://in-go.buy.mi.com/in/serviceplus/api/fos/public/v1/mi-store";
const HEADERS = {
  Accept: "application/json, text/plain, */*",
  Authorization: "Basic bWlzdG9yZS1zZXJ2aWNlcGx1cy1pbnRlZ3JhdGlvbjp4aWFvbWlAQURNSU4=",
  Origin: "https://www.mi.com",
  Referer: MI_URL,
};

async function fetchMiModelRows(request, modelName) {
  const rows = [];
  const limit = 200;
  let offset = 0;
  for (;;) {
    const payload = await apiGetJson(request, `${MI_API_BASE}/spare-part`, {
      headers: HEADERS,
      params: { sort: "id", order: "DESC", query: `modelname:eq:${modelName}`, limit: String(limit), offset: String(offset) },
    });
    const batch = payload.results || [];
    for (const item of batch) {
      const detail = normalizeSpace(String(item.sparePartDetails || ""));
      const category = normalizeSpace(String(item.category || ""));
      const part = !category || detail.toLowerCase().includes(category.toLowerCase()) ? detail : `${category} - ${detail}`;
      rows.push({ part, price_value: item.partPrice, currency: "INR" });
    }
    const count = Number(payload.count || batch.length);
    offset += batch.length;
    if (!batch.length || offset >= count) break;
  }
  return rows;
}

export async function discoverMi(context, conn, delaySeconds, maxModels, modelFilter) {
  const request = context.request;
  let count = 0;
  try {
    const models = await apiGetJson(request, `${MI_API_BASE}/spare-part/category/models/Mobile`, { headers: HEADERS });
    const modelNames = models.map((model) => String(model).trim()).filter((name) => name && modelMatchesFilter(name, modelFilter));
    log.info(`Mi mobile models found: ${modelNames.length}`);
    for (const modelName of modelNames) {
      if (maxModels !== null && count >= maxModels) return;
      try {
        const saved = saveStructuredPriceRows(conn, "Mi", modelName, MI_URL, await fetchMiModelRows(request, modelName));
        if (!saved) throw new Error("No Mi spare-part price rows returned");
        count += 1;
        log.info(`Discovered Mi ${modelName} (${saved} rows, ${count}/${maxModels ?? "all"})`);
        await sleep(delaySeconds);
      } catch (error) {
        log.exception(`Mi model discovery failed: ${modelName}`, error);
        saveCatalogError(conn, "Mi", modelName, MI_URL, errorMessage(error));
      }
    }
  } catch (error) {
    log.exception("Mi catalog discovery failed", error);
  }
}
