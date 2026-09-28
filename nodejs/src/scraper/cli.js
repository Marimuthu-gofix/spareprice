#!/usr/bin/env node
// Command line for the scraper. Same commands and flags as spareprice.py:
//
//   discover-all  --brand all|apple|...|cashify  --delay 3  --max-models N
//                 --model TEXT  --parallel 4  --cashify-city chennai  --db FILE
//                 --samsung-series galaxy-z  --oppo-series "Reno Series"  --realme-series "GT Series"
//   run           --config config.json
//   dry-run       --config config.json
//   init-db       --db FILE
//   export-csv    --db FILE --output FILE
//   push-history  --db FILE --batch 1000 --after-id 0
import { parseArgs } from "node:util";
import fs from "node:fs";

import { log } from "../shared/log.js";
import { connectDb, REMOTE_STORE } from "./db.js";
import { DISCOVERY_BRANDS, discoverAll } from "./discover.js";
import { CASHIFY_CITIES, DEFAULT_CASHIFY_CITY } from "./crawlers/cashify.js";
import { OPPO_MOBILE_SERIES } from "./crawlers/oppo.js";
import { REALME_MOBILE_SERIES } from "./crawlers/realme.js";
import { SAMSUNG_SERIES } from "./crawlers/samsung.js";

const USAGE = `Usage: node src/scraper/cli.js <command> [options]

Commands:
  discover-all   Discover all model/spare-part prices from supported pages
  run            Scrape all enabled config.json entries and save results
  dry-run        Test config.json selectors in a visible browser, without saving
  init-db        Create the SQLite database/table
  export-csv     Export recorded history to CSV
  push-history   Upload the local SQLite history to the remote price store

discover-all options:
  --brand <${["all", ...DISCOVERY_BRANDS].join("|")}>   (default all)
  --delay <seconds>            pause between models (default 3)
  --max-models <n>             stop after n models
  --model <text>               only crawl models containing this text
  --parallel <n>               brand crawls at the same time (default 4)
  --cashify-city <${Object.keys(CASHIFY_CITIES).join("|")}>  (default ${DEFAULT_CASHIFY_CITY})
  --db <file>                  SQLite file (default price_history.sqlite3)
  --samsung-series <${SAMSUNG_SERIES.map(([value]) => value).join("|")}>
  --oppo-series <name>         one of: ${OPPO_MOBILE_SERIES.join(", ")}
  --realme-series <name>       one of: ${REALME_MOBILE_SERIES.join(", ")}
`;

function fail(message) {
  process.stderr.write(message + "\n\n" + USAGE);
  process.exit(2);
}

function choice(value, allowed, flag) {
  if (value !== undefined && !allowed.includes(value)) fail(`--${flag} must be one of: ${allowed.join(", ")}`);
  return value;
}

function integer(value, flag) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) fail(`--${flag} must be a whole number`);
  return parsed;
}

async function pushHistory(dbPath, batchSize, afterId) {
  if (!REMOTE_STORE) {
    log.error("Set PRICE_API_URL and PRICE_API_KEY first (see hostinger_api/README.md).");
    return 1;
  }
  if (!(await REMOTE_STORE.health())) {
    log.error(`${REMOTE_STORE.baseUrl}/health did not answer; check the URL and that the API is uploaded.`);
    return 1;
  }
  const conn = connectDb(dbPath);
  const total = conn.db.prepare("SELECT COUNT(*) AS n FROM price_history WHERE id > ?").get(afterId).n;
  log.info(`Uploading ${total} rows from ${dbPath} to ${REMOTE_STORE.baseUrl}`);
  const select = conn.db.prepare(
    "SELECT id, date, brand, model, part, price, price_value, currency, url, status, error FROM price_history WHERE id > ? ORDER BY id LIMIT ?",
  );
  let sent = 0;
  let inserted = 0;
  let lastId = afterId;
  for (;;) {
    const rows = select.all(lastId, batchSize);
    if (!rows.length) break;
    const result = await REMOTE_STORE.postRows(rows);
    sent += rows.length;
    inserted += Number(result.inserted || 0);
    lastId = rows[rows.length - 1].id;
    log.info(`Uploaded ${sent}/${total} rows (${inserted} new so far, last id ${lastId})`);
  }
  conn.close();
  const status = await REMOTE_STORE.status();
  log.info(`Done. Remote store now holds ${status.count} rows (latest ${status.max_date})`);
  await REMOTE_STORE.close();
  return 0;
}

function exportCsv(dbPath, outputPath) {
  const conn = connectDb(dbPath);
  const rows = conn.db
    .prepare("SELECT date, brand, model, part, price, price_value, currency, status, error, url FROM price_history ORDER BY date, brand, model, part")
    .all();
  const escape = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ["date", "brand", "model", "part", "price", "price_value", "currency", "status", "error", "url"];
  const lines = [header.join(","), ...rows.map((row) => header.map((column) => escape(row[column])).join(","))];
  fs.writeFileSync(outputPath, lines.join("\r\n") + "\r\n", "utf8");
  conn.close();
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      brand: { type: "string" }, delay: { type: "string" }, "max-models": { type: "string" }, model: { type: "string" },
      parallel: { type: "string" }, "cashify-city": { type: "string" }, db: { type: "string" }, "samsung-series": { type: "string" },
      "oppo-series": { type: "string" }, "realme-series": { type: "string" }, config: { type: "string" }, output: { type: "string" },
      batch: { type: "string" }, "after-id": { type: "string" },
    },
    strict: true,
  });
  if (REMOTE_STORE) log.info(`Prices are also being sent to ${REMOTE_STORE.baseUrl}`);

  switch (command) {
    case "discover-all":
      return discoverAll({
        brand: choice(values.brand, ["all", ...DISCOVERY_BRANDS], "brand") ?? "all",
        delay: values.delay === undefined ? 3 : Number(values.delay),
        maxModels: integer(values["max-models"], "max-models") ?? null,
        samsungSeries: choice(values["samsung-series"], SAMSUNG_SERIES.map(([value]) => value), "samsung-series") ?? null,
        oppoSeries: choice(values["oppo-series"], OPPO_MOBILE_SERIES, "oppo-series") ?? null,
        realmeSeries: choice(values["realme-series"], REALME_MOBILE_SERIES, "realme-series") ?? null,
        model: values.model ?? null,
        db: values.db ?? null,
        parallel: integer(values.parallel, "parallel") ?? 4,
        cashifyCity: values["cashify-city"] ?? DEFAULT_CASHIFY_CITY,
      });
    case "run": {
      const { runTracker } = await import("./tracker.js");
      return runTracker(values.config ?? "config.json");
    }
    case "dry-run": {
      const { dryRun } = await import("./tracker.js");
      return dryRun(values.config ?? "config.json");
    }
    case "init-db":
      connectDb(values.db ?? "price_history.sqlite3").close();
      log.info(`Initialized ${values.db ?? "price_history.sqlite3"}`);
      return 0;
    case "export-csv":
      exportCsv(values.db ?? "price_history.sqlite3", values.output ?? "price_history.csv");
      log.info(`Exported ${values.output ?? "price_history.csv"}`);
      return 0;
    case "push-history":
      return pushHistory(values.db ?? "price_history.sqlite3", integer(values.batch, "batch") ?? 1000, integer(values["after-id"], "after-id") ?? 0);
    default:
      fail(`Unknown command: ${command}`);
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    log.exception("Command failed", error);
    process.exit(1);
  });
