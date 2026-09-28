// OPPO India: series cards (li.sidebar-item) and model cards (.product-item).
import { log } from "../../shared/log.js";
import { sleep } from "../../shared/text.js";
import { clickVisibleText, gotoCatalogPage, modelMatchesFilter, newCrawlContext, visibleTexts } from "../browser.js";
import { errorMessage, saveCatalogError, saveCatalogRows } from "../db.js";

export const OPPO_URL = "https://support.oppo.com/in/spare-parts-price/#/";
export const OPPO_MOBILE_SERIES = ["Reno Series", "Find X Series", "A Series", "F Series", "K Series", "Find N Series", "R Series"];

async function openOppoSeries(page, seriesLabel) {
  try {
    const change = page.getByText("Change", { exact: true }).first();
    if ((await change.count()) && (await change.isVisible({ timeout: 800 }))) {
      await change.click({ timeout: 2500 });
      await page.waitForTimeout(1000);
    }
  } catch {
    // no "Change" control shown
  }
  if (!(await visibleTexts(page, "li.sidebar-item")).length) await gotoCatalogPage(page, OPPO_URL);
  try {
    await clickVisibleText(page, "li.sidebar-item", seriesLabel);
  } catch {
    await gotoCatalogPage(page, OPPO_URL);
    await clickVisibleText(page, "li.sidebar-item", seriesLabel);
  }
  await page.waitForTimeout(1200);
  if (!(await visibleTexts(page, ".product-item")).length) {
    await gotoCatalogPage(page, OPPO_URL);
    try {
      await clickVisibleText(page, "li.sidebar-item", seriesLabel);
    } catch {
      log.warn(`OPPO product cards are not visible after selecting series: ${seriesLabel}`);
    }
    await page.waitForTimeout(1200);
  }
}

export async function discoverOppo(browser, conn, delaySeconds, maxModels, oppoSeries, modelFilter) {
  let seriesLabels = OPPO_MOBILE_SERIES;
  if (oppoSeries) seriesLabels = seriesLabels.filter((label) => label === oppoSeries);
  let count = 0;
  const context = await newCrawlContext(browser);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  try {
    await gotoCatalogPage(page, OPPO_URL);
    const availableSeries = new Set(await visibleTexts(page, "li.sidebar-item"));
    for (const seriesLabel of seriesLabels) {
      if (!availableSeries.has(seriesLabel)) {
        log.warn(`OPPO series not found on page: ${seriesLabel}`);
        continue;
      }
      let productNames;
      try {
        await openOppoSeries(page, seriesLabel);
        productNames = (await visibleTexts(page, ".product-item")).filter((name) => modelMatchesFilter(name, modelFilter));
        log.info(`OPPO ${seriesLabel} models found: ${productNames.length}`);
      } catch (error) {
        log.exception(`OPPO series discovery failed: ${seriesLabel}`, error);
        continue;
      }
      for (const modelName of productNames) {
        if (maxModels !== null && count >= maxModels) return;
        try {
          await openOppoSeries(page, seriesLabel);
          await clickVisibleText(page, ".product-item", modelName);
          await page.waitForTimeout(1800);
          const rawRows = await page.locator(".small-item").evaluateAll((items) => items.map((item) => item.innerText.trim()).filter(Boolean));
          const saved = saveCatalogRows(conn, "OPPO", modelName, OPPO_URL, rawRows);
          if (!saved) throw new Error("No OPPO spare-part price rows found after selecting model");
          count += 1;
          log.info(`Discovered OPPO ${modelName} (${saved} rows, ${count}/${maxModels ?? "all"})`);
          await sleep(delaySeconds);
        } catch (error) {
          log.exception(`OPPO model discovery failed: ${modelName}`, error);
          saveCatalogError(conn, "OPPO", modelName, OPPO_URL, errorMessage(error));
        }
      }
    }
  } finally {
    await page.close();
    await context.close();
  }
}
