# The Hostinger site (PHP)

Hostinger shared hosting runs PHP, not Python, inside `public_html`. This
folder is the part of Spareprice that lives there:

- `index.php` + `php/`: a PHP edition of the dashboard. Same page, same
  styles and script as the Python dashboard. It reads the MySQL table
  directly and forwards the scrape buttons to the Python app on Render.
- `public/`: the dashboard's styles and script.
- `.htaccess`: maps the page's routes and keeps `php/` private.
- `../hostinger_api/`: the price store API. On the server it is the `api/`
  folder next to `index.php`.

Scraping never happens on Hostinger. The Python scraper (Render, GitHub
Actions or your PC) posts prices to `/api`; this site only stores and shows
them.

## Upload

```powershell
python hostinger_site/make_zip.py
```

This writes `spareprice_hostinger_site.zip` in the repository root. In
hPanel > Files > File Manager open `public_html`, upload the zip and extract
it there, replacing files. The zip has no `config.php` and no keys, so the
`api/config.php` already on the server is left alone.

First time only: copy `api/config.example.php` to `api/config.php` and fill
in the database lines and `api_key` (see `api/SETUP.txt`).

Then open the site. The dashboard should load with the pill
"Hostinger (live) · MySQL".

| Open | Expect |
|---|---|
| `https://scrape.gofix.info/` | the dashboard |
| `https://scrape.gofix.info/api/health` | `{"status":"ok"}` |
| `https://scrape.gofix.info/api/SETUP.txt` | 403 Forbidden |
| `https://scrape.gofix.info/php/data.php` | 403 Forbidden |

## Settings

Everything comes from `api/config.php`: the database and the `api_key`.

### Where the scrape buttons run

**GitHub Actions (recommended).** Add a token to `api/config.php` and every
scrape button starts the repository's "Weekly full scrape" workflow for the
chosen brand and model. The page shows the run's progress and reloads when
it finishes. There is no memory limit, so "Check All Prices" runs the full
scrape of every brand.

```php
'github_token' => 'github_pat_...',
'github_repo' => 'Marimuthu-gofix/spareprice',
```

Create the token on GitHub: Settings > Developer settings > Personal access
tokens > Fine-grained tokens > Generate new token. Repository access: only
this repository. Permissions: **Actions: Read and write**. Copy the token
into `config.php` on the server only; it never goes into git.

A run takes a minute or two to start, because GitHub prepares a fresh
machine and installs Chromium each time. Only one scrape runs at a time.
Each run uses GitHub Actions minutes (about 2,000 free a month on a private
repository).

**Render app (fallback).** Without `github_token` the buttons are forwarded
to `https://spareprice.onrender.com`, or to `'scraper_url' => 'https://...'`
if set. The first press after a quiet period takes up to a minute while the
free Render app wakes up, and a full scrape can exceed its memory.

The dashboard caches the computed price list in `php/cache/` and refreshes
it whenever the table changes, so a page load is one small query.

Requirements: PHP 8.0 or newer with `pdo_mysql`, `mbstring` and `zip`
(all on by default on Hostinger). Without `zip` the Excel export falls back
to CSV.

## Try it on a PC

With PHP installed (for example XAMPP) and a `hostinger_api/config.php`
pointing at a MySQL or SQLite database:

```powershell
php -d extension=zip -S 127.0.0.1:5005 -t hostinger_site hostinger_site/php/dev-server.php
```
