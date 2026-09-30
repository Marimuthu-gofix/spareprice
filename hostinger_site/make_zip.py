"""Build spareprice_hostinger_site.zip: the exact contents of public_html.

    python hostinger_site/make_zip.py

The zip holds the PHP dashboard (index.php, php/, public/, .htaccess) and the
price API in api/ (taken from ../hostinger_api). Extract it into public_html
in Hostinger's File Manager. It never contains config.php, the cache or any
key, so an existing api/config.php on the server is left alone.
"""
from __future__ import annotations

import zipfile
from pathlib import Path

SITE = Path(__file__).resolve().parent
REPO = SITE.parent
API = REPO / "hostinger_api"
OUT = REPO / "spareprice_hostinger_site.zip"

SITE_FILES = ["index.php", ".htaccess"]
SITE_DIRS = ["php", "public"]
API_FILES = ["index.php", ".htaccess", "config.example.php", "SETUP.txt"]
NEVER = {"config.php", "cache", ".env"}


def main() -> None:
    entries: list[tuple[Path, str]] = []
    for name in SITE_FILES:
        entries.append((SITE / name, name))
    for folder in SITE_DIRS:
        for path in sorted((SITE / folder).rglob("*")):
            if path.is_file() and not (set(path.relative_to(SITE).parts) & NEVER):
                entries.append((path, path.relative_to(SITE).as_posix()))
    for name in API_FILES:
        entries.append((API / name, f"api/{name}"))

    missing = [str(source) for source, _ in entries if not source.is_file()]
    if missing:
        raise SystemExit("Missing files: " + ", ".join(missing))

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source, name in entries:
            archive.write(source, name)
            print(f"  {name} ({source.stat().st_size} bytes)")
    print(f"\nWrote {OUT.name}: {len(entries)} files, {OUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
