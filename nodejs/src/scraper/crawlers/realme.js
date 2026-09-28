// realme India: series in .main-left .item-content-i, models in .main-right .item.
import { log } from "../../shared/log.js";
import { sleep } from "../../shared/text.js";
import { clickVisibleText, gotoCatalogPage, modelMatchesFilter, newCrawlContext, visibleTexts } from "../browser.js";
import { errorMessage, saveCatalogError, saveCatalogRows } from "../db.js";

export const REALME_URL = "https://www.realme.com/in/support/spare-parts-price";
export const REALME_MOBILE_SERIES = ["GT Series", "Number Series", "P Series", "Narzo Series", "C Series", "Neo Series", "X Series", "U Series"];

async function openRealmeSeries(page, seriesLabel) {
  try {
    const change = page.getByText("Change device").first();
    if ((await change.count()) && (await change.isVisible({ timeout: 800 }))) {
      await change.click({ timeout: 2500 });
      await page.waitForTimeout(1000);
    }
  } catch {
    // no "Change device" control shown
  }
  if (!(await visibleTexts(page, ".main-left .item-content-i")).length) await gotoCatalogPage(page, REALME_URL);
  try {
    await clickVisibleText(page, ".main-left .item-content-i", seriesLabel);
  } catch {
    await gotoCatalogPage(page, REALME_URL);
    await clickVisibleText(page, ".main-left .item-content-i", seriesLabel);
  }
  await page.waitForTimeout(1200);
}

export async function discoverRealme(browser, conn, delaySeconds, maxModels, realmeSeries, modelFilter) {
  let seriesLabels = REALME_MOBILE_SERIES;
  if (realmeSeries) seriesLabels = seriesLabels.filter((label) => label === realmeSeries);
  let count = 0;
  const context = await newCrawlContext(browser);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  try {
    await gotoCatalogPage(page, REALME_URL);
    for (const seriesLabel of seriesLabels) {
      let productNames;
      try {
        await openRealmeSeries(page, seriesLabel);
        productNames = (await visibleTexts(page, ".main-right .item")).filter((name) => modelMatchesFilter(name, modelFilter));
        log.info(`realme ${seriesLabel} models found: ${productNames.length}`);
      } catch (error) {
        log.exception(`realme series discovery failed: ${seriesLabel}`, error);
        continue;
      }
      for (const modelName of productNames) {
        if (maxModels !== null && count >= maxModels) return;
        try {
          await openRealmeSeries(page, seriesLabel);
          await clickVisibleText(page, ".main-right .item", modelName);
          await page.waitForTimeout(2200);
          const rawRows = await page
            .locator(".spare-parts-price .result-collapse .item")
            .evaluateAll((items) => items.map((item) => item.innerText.trim()).filter(Boolean));
          const saved = saveCatalogRows(conn, "realme", modelName, REALME_URL, rawRows);
          if (!saved) throw new Error("No realme spare-part price rows found after selecting model");
          count += 1;
          log.info(`Discovered realme ${modelName} (${saved} rows, ${count}/${maxModels ?? "all"})`);
          await sleep(delaySeconds);
        } catch (error) {
          log.exception(`realme model discovery failed: ${modelName}`, error);
          saveCatalogError(conn, "realme", modelName, REALME_URL, errorMessage(error));
        }
      }
    }
  } finally {
    await page.close();
    await context.close();
  }
}
