# Spareprice storage API for Hostinger Business

A small PHP + MySQL API that holds the scraped prices. Render scrapes and
shows the data; this keeps it safe between deploys.

## Install on Hostinger (about 10 minutes)

1. **Create the database.** In hPanel open *Databases > Management*, create a
   database and a user, and note the database name, user name and password.
2. **Upload the files.** In hPanel open *File Manager*, go to `public_html`,
   create a folder named `api`, and upload `index.php`, `.htaccess` and
   `config.example.php` into it.
3. **Create the config.** Copy `config.example.php` to `config.php` in the same
   folder and edit it: paste the database details from step 1 and set
   `api_key` to a long random secret.
4. **Check it.** Open `https://your-domain.com/api/health` in a browser. It
   should show `{"status":"ok"}`.

The `price_history` table is created automatically on the first request.

The folder can live anywhere under `public_html`; the rewrite rule in
`.htaccess` is relative to the folder, so nothing else depends on the
location. Just use the matching URL in `PRICE_API_URL`.

## Point Render at it

In the Render dashboard, add two environment variables to the web service:

| Variable | Value |
|---|---|
| `PRICE_API_URL` | `https://your-domain.com/api` |
| `PRICE_API_KEY` | the `api_key` from `config.php` |

Redeploy. From then on every scraped price is sent here as well as written
locally, and the dashboard reads from here.

## Copy the existing history

Run once from your PC, with the same two variables set, to upload the rows
already in `price_history.sqlite3`:

```powershell
$env:PRICE_API_URL = "https://your-domain.com/api"
$env:PRICE_API_KEY = "your-secret"
.\.venv\Scripts\python.exe spareprice.py push-history
```

It is safe to run again; rows already uploaded are skipped.

## Routes

All responses are JSON. Every route except `/health` needs an `X-API-Key`
header.

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Liveness check, no key needed |
| GET | `/status` | `{count, max_id, max_date}` |
| GET | `/prices?after_id=0&limit=5000` | Rows with id greater than `after_id`, oldest first |
| POST | `/prices` | Body `{"rows": [...]}`, up to 5000 rows; duplicates are ignored |

A row has `date, brand, model, part, price, price_value, currency, url,
status, error`, the same columns as the SQLite table.

## Local test

PHP's built-in server plus SQLite is enough to try the API without MySQL:

```powershell
cd hostinger_api
Copy-Item config.example.php config.php
# edit config.php:  'dsn' => 'sqlite:' . __DIR__ . '/test.sqlite3'
php -S 127.0.0.1:8090 index.php
```
