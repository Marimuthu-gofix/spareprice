# Spareprice, Node.js edition

The same project as the Python version in the parent folder, ported to
Node.js: a Playwright scraper for mobile spare-part prices across Apple,
Samsung, OPPO, realme, OnePlus, Mi/Xiaomi, vivo, iQOO, Motorola and Cashify,
and an Express dashboard that shows official and Cashify prices side by side.

Both editions read and write the same data: the SQLite file, the Hostinger
store and `config.json` are shared, so you can run either one.

## Requirements

- Node.js 22.13 or newer (uses the built-in `node:sqlite` module, no native
  build tools needed)
- Chromium for Playwright, installed by the command below

## Install

```powershell
cd nodejs
npm install
npx playwright install chromium
```

## Run the dashboard

```powershell
npm start
```

Then open http://127.0.0.1:5000. `PORT` and `HOST` override the address.

The dashboard reads the Hostinger store when `PRICE_API_URL` and
`PRICE_API_KEY` are set, otherwise `price_history.sqlite3` (this folder's, or
the parent folder's if only that exists). `DB_PATH` points it at another
file.

## Scrape

```powershell
# everything, four sites at a time
npm run discover -- --brand all --delay 1

# one brand, one model family
node src/scraper/cli.js discover-all --brand apple --model "iPhone 15" --delay 1
node src/scraper/cli.js discover-all --brand cashify --model "Samsung Galaxy Z Fold" --delay 0.5

# the config.json shortlist
node src/scraper/cli.js run --config ../config.json

# upload the local history to the Hostinger store
node src/scraper/cli.js push-history --db ../price_history.sqlite3
```

`node src/scraper/cli.js --help` lists every command and flag. They match the
Python version, including `--parallel`, `--cashify-city`, `--max-models` and
the per-brand series filters. The `plot` command was not ported; the
dashboard chart covers it.

With `PRICE_API_URL` and `PRICE_API_KEY` set, every scraped row is sent to
the Hostinger store as well as written locally.

## How the pieces map to the Python version

| Python | Node.js |
|---|---|
| `spareprice.py` | `src/scraper/cli.js`, `discover.js`, `tracker.js`, `crawlers/*.js` |
| `price_store.py` | `src/shared/priceStore.js` |
| `dashboard.py` | `src/dashboard/server.js`, `data.js`, `jobs.js`, `exports.js` |
| `templates/dashboard.html` (Jinja) | `views/dashboard.html` (Nunjucks) |
| `static/` | `public/` |

The Cashify crawler uses the site's JSON API, the same approach as the
Python version: one page load captures the token (cached in
`.cashify_token.json`), then prices come from small JSON calls with no
browser. Manufacturer sites still need Chromium.

## Deploy

The `Dockerfile` builds on Microsoft's Playwright image, which already holds
Node and the matching Chromium, so the image builds in a minute. Set
`PRICE_API_URL`, `PRICE_API_KEY` and `PORT` on the host. On Render the
`RENDER` variable makes dashboard-started scrapes run one site at a time and
frees the dashboard's cached data while a scrape runs, exactly like the
Python version.
