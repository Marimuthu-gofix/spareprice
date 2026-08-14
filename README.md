# Spareprice

Small, configurable price tracker for a fixed shortlist of Samsung and Apple spare-part repair prices.

It uses Playwright because the referenced Apple and Samsung pages populate prices after JavaScript-driven selection flows. Keep the run frequency low and use this for personal tracking only; both sites may restrict automated access in their terms.

## Install

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m playwright install chromium
Copy-Item config.example.json config.json
```

Edit `config.json` with your 10-20 model/part combinations.

## Configure Entries

Each entry has:

- `brand`, `model`, `part`, `url`: saved with every observation.
- `actions`: the browser steps needed to pick the model/part.
- `price_selector`: the selector used after the flow completes.
- `currency`: optional default when the extracted text does not contain a currency symbol.

Supported action types:

- `click`: click a CSS selector.
- `click_text`: click visible text.
- `fill`: fill an input. Optional `press`, such as `"Enter"`.
- `select_option`: select from a native `<select>` by `label`, `value`, or `index`.
- `wait_for_selector`: wait for a selector to become visible.
- `wait_for_timeout`: wait a fixed number of milliseconds.

For custom controls that overlay hidden inputs, `click` and `click_text` also accept `"force": true`.

The fragile assumptions are intentionally in `config.json`: selectors, visible labels, and text like `Battery`, `Display`, `Mobile Devices`, or `iPhone 14`. If Apple or Samsung changes page structure, update the affected entry's `actions` and `price_selector`.

## Run Once

```powershell
.\.venv\Scripts\Activate.ps1
python spareprice.py run --config config.json
```

Results are saved to SQLite in `price_history.sqlite3` by default. The table includes the requested fields `date`, `brand`, `model`, `part`, and `price`, plus extra fields for numeric plotting, status, errors, and source URL.

Errors are stored as rows with `status = 'error'`. One bad page will not stop the rest of the shortlist.

## Test Selectors

Use this after editing `config.json`. It opens a visible browser, tries every enabled entry, logs the extracted price, and does not write to SQLite.

```powershell
python spareprice.py dry-run --config config.json
```

## Export CSV

```powershell
python spareprice.py export-csv --db price_history.sqlite3 --output price_history.csv
```

## Plot Trends

```powershell
python spareprice.py plot --db price_history.sqlite3 --output iphone14_battery.png --brand Apple --model "iPhone 14" --part Battery
```

Omit filters to plot all successful tracked series:

```powershell
python spareprice.py plot --db price_history.sqlite3 --output all_prices.png
```

## Local Dashboard

Start the browser dashboard:

```powershell
python dashboard.py
```

Then open:

```text
http://127.0.0.1:5000
```

The dashboard reads `price_history.sqlite3` and shows latest prices, recent checks, filters, and a trend chart.

Use **Check All Prices** in the dashboard to run the scraper for every enabled item in `config.json`. The button runs in the background and refreshes the page after it finishes.

Use **Discover All Models** to crawl all model and spare-part/service prices exposed by the supported Apple and Samsung pages. This can take several minutes because it waits between models.

You can also run catalog discovery from PowerShell:

```powershell
python spareprice.py discover-all --brand all --delay 3
```

For a quick test:

```powershell
python spareprice.py discover-all --brand samsung --max-models 1 --delay 1
```

Keep the delay conservative. Full-catalog scraping is more likely to trigger blocking or ToS issues than your original small shortlist.

## Daily Schedule

### Windows Task Scheduler

1. Open Task Scheduler.
2. Choose **Create Basic Task**.
3. Trigger: **Daily**.
4. Action: **Start a Program**.
5. Program/script:

```text
D:\spareprice\.venv\Scripts\python.exe
```

6. Add arguments:

```text
D:\spareprice\spareprice.py run --config D:\spareprice\config.json
```

7. Start in:

```text
D:\spareprice
```

### Linux or macOS Cron

Run `crontab -e` and add:

```cron
15 8 * * * cd /path/to/spareprice && /path/to/spareprice/.venv/bin/python spareprice.py run --config config.json >> spareprice.log 2>&1
```

This runs once daily at 08:15 local time.

## Notes

- Use a delay of several seconds between entries. The default is `6`.
- Keep `headless` as `false` temporarily when fixing selectors so you can watch the browser.
- Avoid high-frequency or commercial scraping; low-volume personal tracking is much less likely to be blocked.
- If prices start recording as errors, inspect the latest `error` column in the CSV and update the corresponding selectors.
