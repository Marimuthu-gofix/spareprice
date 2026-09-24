"""Client for the remote price store (the PHP API in hostinger_api/).

Configured with two environment variables:

    PRICE_API_URL   e.g. https://your-domain.com/api
    PRICE_API_KEY   the api_key from the API's config.php

When they are not set, `RemotePriceStore.from_env()` returns None and the
rest of the project keeps using the local SQLite file only.

The scraper calls `add()` for every saved row. Rows are buffered and sent in
batches, from a background thread every few seconds and again at exit, so a
slow network never slows the crawl and a crash loses at most a few seconds
of rows. Failed batches stay in the buffer and are retried.
"""
from __future__ import annotations

import atexit
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

LOGGER = logging.getLogger("price_store")

ROW_FIELDS = ("date", "brand", "model", "part", "price", "price_value", "currency", "url", "status", "error")


class RemotePriceStore:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        batch_size: int = 500,
        flush_seconds: float = 5.0,
        timeout: float = 60.0,
        max_buffer: int = 50_000,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.batch_size = batch_size
        self.timeout = timeout
        self.max_buffer = max_buffer
        self._buffer: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self._flush_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        if flush_seconds > 0:
            self._thread = threading.Thread(
                target=self._flush_loop, args=(flush_seconds,), name="price-store-flush", daemon=True
            )
            self._thread.start()
            atexit.register(self.close)

    @classmethod
    def from_env(cls) -> RemotePriceStore | None:
        url = (os.environ.get("PRICE_API_URL") or "").strip()
        key = (os.environ.get("PRICE_API_KEY") or "").strip()
        if not url or not key:
            return None
        return cls(url, key)

    # ------------------------------------------------------------ requests
    def _request(self, method: str, route: str, params: dict[str, Any] | None = None, body: Any = None) -> Any:
        url = f"{self.base_url}/{route.lstrip('/')}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("X-API-Key", self.api_key)
        request.add_header("Accept", "application/json")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            raise RuntimeError(f"{method} {url} failed with HTTP {exc.code}: {detail}") from exc

    def health(self) -> bool:
        try:
            return self._request("GET", "health").get("status") == "ok"
        except Exception:
            return False

    def status(self) -> dict[str, Any]:
        return self._request("GET", "status")

    def post_rows(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        clean = [{field: row.get(field) for field in ROW_FIELDS} for row in rows]
        return self._request("POST", "prices", body={"rows": clean})

    def fetch_all(self, page_size: int = 5000) -> list[dict[str, Any]]:
        """Every row in the store, oldest first."""
        rows: list[dict[str, Any]] = []
        after_id = 0
        while True:
            page = self._request("GET", "prices", params={"after_id": after_id, "limit": page_size})
            rows.extend(page.get("rows") or [])
            if not page.get("has_more"):
                return rows
            after_id = int(page["next_after_id"])

    # ------------------------------------------------------------ buffering
    def add(self, row: dict[str, Any]) -> None:
        with self._lock:
            if len(self._buffer) >= self.max_buffer:
                LOGGER.warning("Remote price buffer is full (%s rows); dropping the oldest", self.max_buffer)
                del self._buffer[: self.batch_size]
            self._buffer.append({field: row.get(field) for field in ROW_FIELDS})
            ready = len(self._buffer) >= self.batch_size
        if ready:
            self.flush()

    def flush(self) -> bool:
        """Send everything buffered. Returns False (and keeps the rows) if the
        API could not be reached."""
        with self._flush_lock:
            while True:
                with self._lock:
                    batch = self._buffer[: self.batch_size]
                if not batch:
                    return True
                try:
                    result = self.post_rows(batch)
                except Exception as exc:
                    LOGGER.warning("Could not send %s rows to %s: %s", len(batch), self.base_url, exc)
                    return False
                with self._lock:
                    del self._buffer[: len(batch)]
                LOGGER.debug("Sent %s rows to the remote store (%s new)", result.get("received"), result.get("inserted"))

    def pending(self) -> int:
        with self._lock:
            return len(self._buffer)

    def _flush_loop(self, interval: float) -> None:
        while not self._stop.wait(interval):
            self.flush()

    def close(self) -> None:
        """Stop the background thread and make a last attempt to send rows."""
        self._stop.set()
        for attempt in range(3):
            if self.flush():
                return
            time.sleep(2 * (attempt + 1))
        left = self.pending()
        if left:
            LOGGER.error("%s rows could not be sent to the remote store", left)
