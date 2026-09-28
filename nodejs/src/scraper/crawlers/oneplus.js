// OnePlus India: the public page is powered by OPPO/OnePlus CMS JSON endpoints.
import { log } from "../../shared/log.js";
import { coercePriceValue, sleep } from "../../shared/text.js";
import { apiPostJson, modelMatchesFilter } from "../browser.js";
import { errorMessage, saveCatalogError, saveStructuredPriceRows } from "../db.js";

export const ONEPLUS_URL = "https://service.oneplus.com/in/spare-parts-price#/";
const ONEPLUS_API_BASE = "https://ind-sow-cms.oneplus.com/oppo-api";
const HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/json",
  Origin: "https://service.oneplus.com",
  Referer: "https://service.oneplus.com/in/spare-parts-price",
};

export function oneplusPriceRows(payload) {
  const rows = [];
  for (const group of payload?.data?.partPriceList || []) {
    const children = group.childList || [group];
    for (const item of children) {
      const priceValue = coercePriceValue(item.discountRetailPrice || item.retailPrice);
      if (priceValue === null) continue;
      rows.push({
        part: item.partName || item.lv3ClassificationName || group.groupName,
        price_value: priceValue,
        currency: item.retailPriceCurrency || "INR",
      });
    }
  }
  return rows;
}

export async function discoverOneplus(context, conn, delaySeconds, maxModels, modelFilter) {
  const request = context.request;
  let count = 0;
  try {
    const productPayload = await apiPostJson(request, `${ONEPLUS_API_BASE}/basic/v1/getProduct`, { data: { regionIsoCode2: "IN" }, headers: HEADERS });
    const products = (productPayload.data || []).filter(
      (item) => String(item.categoryCode) === "01" && modelMatchesFilter(String(item.marketingModelName || ""), modelFilter),
    );
    log.info(`OnePlus mobile models found: ${products.length}`);
    for (const item of products) {
      if (maxModels !== null && count >= maxModels) return;
      const modelName = String(item.marketingModelName || "").trim();
      const modelCode = String(item.marketingModelCode || "").trim();
      if (!modelName || !modelCode) continue;
      try {
        const pricePayload = await apiPostJson(request, `${ONEPLUS_API_BASE}/basic/v1/getPartPriceNew`, {
          data: { marketingModelCode: modelCode, regionIsoCode2: "IN" },
          headers: HEADERS,
        });
        const saved = saveStructuredPriceRows(conn, "OnePlus", modelName, ONEPLUS_URL, oneplusPriceRows(pricePayload));
        if (!saved) throw new Error("No OnePlus spare-part price rows returned");
        count += 1;
        log.info(`Discovered OnePlus ${modelName} (${saved} rows, ${count}/${maxModels ?? "all"})`);
        await sleep(delaySeconds);
      } catch (error) {
        log.exception(`OnePlus model discovery failed: ${modelName}`, error);
        saveCatalogError(conn, "OnePlus", modelName, ONEPLUS_URL, errorMessage(error));
      }
    }
  } catch (error) {
    log.exception("OnePlus catalog discovery failed", error);
  }
}
