// discover-all: run the brand crawlers, up to `parallel` at once. Playwright
// and the browser start only when a crawler needs them; Cashify runs through
// the site API and usually needs neither.
import { chromium } from "playwright";

import { log } from "../shared/log.js";
import { browserLaunchArgs, newCrawlContext } from "./browser.js";
import { connectDb, defaultDbPath, REMOTE_STORE } from "./db.js";
import { discoverApple } from "./crawlers/apple.js";
import { cashifyCityCookies, DEFAULT_CASHIFY_CITY, discoverCashify } from "./crawlers/cashify.js";
import { discoverMi } from "./crawlers/mi.js";
import { discoverMotorola } from "./crawlers/motorola.js";
import { discoverOneplus } from "./crawlers/oneplus.js";
import { discoverOppo } from "./crawlers/oppo.js";
import { discoverRealme } from "./crawlers/realme.js";
import { discoverSamsung } from "./crawlers/samsung.js";
import { discoverIqoo, discoverVivo } from "./crawlers/vivo.js";

export const DISCOVERY_BRANDS = ["apple", "samsung", "oppo", "realme", "oneplus", "mi", "vivo", "iqoo", "motorola", "cashify"];

export async function flushRemoteStore() {
  if (!REMOTE_STORE) return;
  if (await REMOTE_STORE.flush()) log.info(`All rows were sent to ${REMOTE_STORE.baseUrl}`);
  else log.warn(`${REMOTE_STORE.pending()} rows are still waiting to be sent to ${REMOTE_STORE.baseUrl}`);
  await REMOTE_STORE.close();
}

export async function discoverAll({
  brand = "all",
  delay = 3,
  maxModels = null,
  samsungSeries = null,
  oppoSeries = null,
  realmeSeries = null,
  model = null,
  db = null,
  parallel = 4,
  cashifyCity = DEFAULT_CASHIFY_CITY,
}) {
  const conn = connectDb(db || defaultDbPath("price_history.sqlite3"));
  const cityCookies = cashifyCityCookies(cashifyCity);
  const launched = {};
  let launching = null;

  const getBrowser = async () => {
    if (!launching) {
      launching = (async () => {
        launched.browser = await chromium.launch({ headless: true, args: browserLaunchArgs() });
        launched.context = await newCrawlContext(launched.browser);
        await launched.context.addCookies(cityCookies);
      })();
    }
    await launching;
    return launched.browser;
  };
  const getContext = async () => {
    await getBrowser();
    return launched.context;
  };
  const withContext = (crawler, ...args) => async () => crawler(await getContext(), ...args);
  const withBrowser = (crawler, ...args) => async () => crawler(await getBrowser(), ...args);

  const wants = (name) => brand === "all" || brand === name;
  const jobs = [];
  if (wants("apple")) jobs.push(["Apple", withContext(discoverApple, conn, delay, maxModels, model)]);
  if (wants("samsung")) jobs.push(["Samsung", withBrowser(discoverSamsung, conn, delay, maxModels, samsungSeries, model)]);
  if (wants("oppo")) jobs.push(["OPPO", withBrowser(discoverOppo, conn, delay, maxModels, oppoSeries, model)]);
  if (wants("realme")) jobs.push(["realme", withBrowser(discoverRealme, conn, delay, maxModels, realmeSeries, model)]);
  if (wants("oneplus")) jobs.push(["OnePlus", withContext(discoverOneplus, conn, delay, maxModels, model)]);
  if (wants("mi")) jobs.push(["Mi", withContext(discoverMi, conn, delay, maxModels, model)]);
  if (wants("vivo")) jobs.push(["vivo", withContext(discoverVivo, conn, delay, maxModels, model)]);
  if (wants("iqoo")) jobs.push(["iQOO", withContext(discoverIqoo, conn, delay, maxModels, model)]);
  if (wants("motorola")) jobs.push(["Motorola", withContext(discoverMotorola, conn, delay, maxModels, model)]);
  if (wants("cashify")) jobs.push(["Cashify", () => discoverCashify(getContext, conn, delay, maxModels, model)]);

  const limit = Math.max(1, parallel);
  log.info(`Running ${jobs.length} catalog crawls, up to ${limit} at a time`);
  const queue = [...jobs];
  const worker = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [name, job] = next;
      log.info(`Starting ${name} catalog discovery`);
      try {
        await job();
      } catch (error) {
        log.exception(`${name} catalog discovery failed`, error);
      }
      log.info(`Finished ${name} catalog discovery`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  } finally {
    if (launched.context) await launched.context.close();
    if (launched.browser) await launched.browser.close();
    conn.close();
  }
  await flushRemoteStore();
  return 0;
}
