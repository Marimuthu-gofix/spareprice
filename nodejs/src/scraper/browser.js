// Browser helpers shared by the crawlers. Ported from spareprice.py.

import { log } from "../shared/log.js";

/** True on small hosts (Render sets RENDER=true) or when SCRAPE_LOW_MEMORY is set. */
export function lowMemoryMode() {
  return Boolean(process.env.SCRAPE_LOW_MEMORY || process.env.RENDER);
}

export function browserLaunchArgs() {
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  if (lowMemoryMode()) {
    // Trade speed and isolation for a smaller footprint on a 512 MB instance.
    args.push(
      "--no-zygote",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-extensions",
      "--disable-default-apps",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-features=IsolateOrigins,site-per-process,TranslateUI,MediaRouter",
      "--mute-audio",
      "--no-first-run",
    );
  }
  return args;
}

// Requests the catalog crawlers never need. Skipping them makes every page
// load faster without changing how often a site is hit.
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);
const BLOCKED_URL_FRAGMENTS = [
  "google-analytics.", "googletagmanager.", "doubleclick.", "facebook.", "hotjar.", "clarity.ms",
  "moengage", "webengage", "clevertap", "branch.io", "appsflyer", "newrelic", "sentry.io",
  "googlesyndication.", "adservice.", "googleadservices.", "criteo.", "taboola.", "outbrain.",
  "freshchat", "freshworks", "intercom", "zendesk", "tawk.to", "livechat", "onesignal", "pushengage",
  "amplitude.", "mixpanel.", "segment.io", "segment.com", "optimizely.", "fullstory.", "smartlook",
  "youtube.", "ytimg.", "vimeo.", "twitter.", "x.com/", "linkedin.", "pinterest.", "tiktok.", "snapchat.",
  "bing.com/bat", "bat.bing", "recaptcha", "gstatic.com/recaptcha", "firebase", "kissmetrics", "quantserve",
];

export async function newCrawlContext(browser) {
  const context = await browser.newContext({ locale: "en-IN", viewport: { width: 1366, height: 900 } });
  await context.route("**/*", (route) => {
    const request = route.request();
    const url = request.url();
    if (BLOCKED_RESOURCE_TYPES.has(request.resourceType()) || BLOCKED_URL_FRAGMENTS.some((fragment) => url.includes(fragment))) {
      return route.abort();
    }
    return route.continue();
  });
  return context;
}

export function modelMatchesFilter(model, modelFilter) {
  if (!modelFilter) return true;
  return String(model).toLowerCase().includes(modelFilter.toLowerCase());
}

export async function gotoCatalogPage(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (error) {
    log.warn(`Page navigation timed out; checking whether content is usable: ${url}`);
    await page.waitForTimeout(3000);
    if (!(await page.locator("body").count())) throw error;
  }
  try {
    await page.waitForLoadState("networkidle", { timeout: 10000 });
  } catch {
    log.info(`Continuing after networkidle timeout: ${url}`);
  }
  await dismissCommonPopups(page);
  await page.waitForTimeout(1200);
}

export async function dismissCommonPopups(page) {
  for (const label of ["Accept", "Accept All", "I agree", "Continue", "No thanks", "Close"]) {
    try {
      const button = page.getByRole("button", { name: new RegExp(label, "i") }).first();
      if ((await button.count()) && (await button.isVisible({ timeout: 750 }))) {
        await button.click({ timeout: 1500 });
        await page.waitForTimeout(500);
      }
    } catch {
      // popup not present
    }
  }
}

export function visibleTexts(page, selector) {
  return page.locator(selector).evaluateAll((elements) =>
    elements
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      })
      .map((element) => element.innerText.trim())
      .filter(Boolean),
  );
}

export async function clickVisibleText(page, selector, text) {
  const clicked = await page.locator(selector).evaluateAll((elements, wanted) => {
    const normalizedWanted = wanted.replace(/\s+/g, " ").trim();
    const match = elements.find((element) => {
      const box = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const normalizedText = element.innerText.replace(/\s+/g, " ").trim();
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none" && normalizedText === normalizedWanted;
    });
    if (!match) return false;
    match.scrollIntoView({ block: "center", inline: "center" });
    match.click();
    return true;
  }, text);
  if (!clicked) throw new Error(`Visible element not found for selector '${selector}' and text '${text}'`);
}

export async function apiGetJson(request, url, { headers = {}, params } = {}) {
  const response = await request.get(url, { headers, params });
  if (!response.ok()) throw new Error(`GET ${url} failed with HTTP ${response.status()}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

export async function apiPostJson(request, url, { data, form, headers = {} } = {}) {
  const response = await request.post(url, { data, form, headers });
  if (!response.ok()) throw new Error(`POST ${url} failed with HTTP ${response.status()}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}
