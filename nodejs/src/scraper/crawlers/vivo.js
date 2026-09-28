// vivo and iQOO India: model ids in .select-model-item, prices from
// queryPriceByProductId. iQOO loads prices after clicking a model in its picker.
import { log } from "../../shared/log.js";
import { coercePriceValue, cssEscape, sleep } from "../../shared/text.js";
import { apiPostJson, gotoCatalogPage, modelMatchesFilter } from "../browser.js";
import { errorMessage, saveCatalogError, saveStructuredPriceRows } from "../db.js";

export const VIVO_URL = "https://www.vivo.com/in/support/accessory";
export const IQOO_URL = "https://www.iqoo.com/in/support/accessory";

export function vivoPriceRows(payload) {
  const sparePartVo = payload?.data?.sparePartVO || {};
  const currency = sparePartVo.spareCompany || "INR";
  return (sparePartVo.sparePartsVoList || []).map((item) => {
    const priceText = item.materialPrice || item.promotionPrice || item.price;
    return { part: item.name, price_text: priceText, price_value: coercePriceValue(priceText), currency };
  });
}

function readModels(page) {
  return page.locator(".select-model-item").evaluateAll((items) =>
    items.map((item) => ({ id: item.getAttribute("data-id"), name: item.innerText.trim() })).filter((item) => item.id && item.name),
  );
}

export async function discoverVivo(context, conn, delaySeconds, maxModels, modelFilter) {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  let count = 0;
  try {
    await gotoCatalogPage(page, VIVO_URL);
    const models = (await readModels(page)).filter((item) => modelMatchesFilter(item.name, modelFilter));
    log.info(`vivo mobile models found: ${models.length}`);
    for (const item of models) {
      if (maxModels !== null && count >= maxModels) return;
      const modelName = String(item.name).trim();
      try {
        const payload = await apiPostJson(context.request, "https://www.vivo.com/in/support/queryPriceByProductId", {
          form: { id: String(item.id).trim() },
          headers: { Referer: VIVO_URL, Origin: "https://www.vivo.com" },
        });
        const saved = saveStructuredPriceRows(conn, "vivo", modelName, VIVO_URL, vivoPriceRows(payload));
        if (!saved) throw new Error("No vivo spare-part price rows returned");
        count += 1;
        log.info(`Discovered vivo ${modelName} (${saved} rows, ${count}/${maxModels ?? "all"})`);
        await sleep(delaySeconds);
      } catch (error) {
        log.exception(`vivo model discovery failed: ${modelName}`, error);
        saveCatalogError(conn, "vivo", modelName, VIVO_URL, errorMessage(error));
      }
    }
  } catch (error) {
    log.exception("vivo catalog discovery failed", error);
  } finally {
    await page.close();
  }
}

export async function discoverIqoo(context, conn, delaySeconds, maxModels, modelFilter) {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  let count = 0;
  try {
    await gotoCatalogPage(page, IQOO_URL);
    const models = (await readModels(page)).filter((item) => modelMatchesFilter(item.name, modelFilter));
    log.info(`iQOO mobile models found: ${models.length}`);
    for (const item of models) {
      if (maxModels !== null && count >= maxModels) return;
      const modelName = String(item.name).trim();
      try {
        await page.locator("#boxSelectModel").click();
        const model = page.locator(`.select-model-item[data-id="${cssEscape(String(item.id).trim())}"]`).first();
        const [response] = await Promise.all([
          page.waitForResponse((candidate) => candidate.url().includes("queryPriceByProductId")),
          model.click(),
        ]);
        const saved = saveStructuredPriceRows(conn, "iQOO", modelName, IQOO_URL, vivoPriceRows(await response.json()));
        if (!saved) throw new Error("No iQOO spare-part price rows returned");
        count += 1;
        log.info(`Discovered iQOO ${modelName} (${saved} rows, ${count}/${maxModels ?? "all"})`);
        await sleep(delaySeconds);
      } catch (error) {
        log.exception(`iQOO model discovery failed: ${modelName}`, error);
        saveCatalogError(conn, "iQOO", modelName, IQOO_URL, errorMessage(error));
      }
    }
  } catch (error) {
    log.exception("iQOO catalog discovery failed", error);
  } finally {
    await page.close();
  }
}
