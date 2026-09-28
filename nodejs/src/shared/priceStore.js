// Client for the remote price store (the PHP API in ../hostinger_api).
// Ported from price_store.py.
//
// Configured with PRICE_API_URL and PRICE_API_KEY. When they are not set,
// RemotePriceStore.fromEnv() returns null and only the local SQLite file is
// used. Rows are buffered and sent in batches from a timer so a slow network
// never slows the crawl; failed batches stay in the buffer and are retried.

import { log } from "./log.js";

export const ROW_FIELDS = ["date", "brand", "model", "part", "price", "price_value", "currency", "url", "status", "error"];

function pick(row) {
  const out = {};
  for (const field of ROW_FIELDS) out[field] = row[field] ?? null;
  return out;
}

export class RemotePriceStore {
  constructor(baseUrl, apiKey, { batchSize = 500, flushSeconds = 5, timeoutMs = 60000, maxBuffer = 50000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.batchSize = batchSize;
    this.timeoutMs = timeoutMs;
    this.maxBuffer = maxBuffer;
    this.buffer = [];
    this.flushing = null;
    this.timer = flushSeconds > 0 ? setInterval(() => this.flush().catch(() => {}), flushSeconds * 1000) : null;
    if (this.timer) this.timer.unref();
  }

  static fromEnv() {
    const url = (process.env.PRICE_API_URL || "").trim();
    const key = (process.env.PRICE_API_KEY || "").trim();
    return url && key ? new RemotePriceStore(url, key) : null;
  }

  async request(method, route, { params, body } = {}) {
    let url = `${this.baseUrl}/${route.replace(/^\/+/, "")}`;
    if (params) url += "?" + new URLSearchParams(params).toString();
    const response = await fetch(url, {
      method,
      headers: { "X-API-Key": this.apiKey, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`${method} ${url} failed with HTTP ${response.status}: ${detail}`);
    }
    return response.json();
  }

  async health() {
    try {
      return (await this.request("GET", "health")).status === "ok";
    } catch {
      return false;
    }
  }

  status() {
    return this.request("GET", "status");
  }

  postRows(rows) {
    return this.request("POST", "prices", { body: { rows: rows.map(pick) } });
  }

  /** Every row in the store, oldest first. */
  async fetchAll(pageSize = 5000) {
    const rows = [];
    let afterId = 0;
    for (;;) {
      const page = await this.request("GET", "prices", { params: { after_id: afterId, limit: pageSize } });
      rows.push(...(page.rows || []));
      if (!page.has_more) return rows;
      afterId = Number(page.next_after_id);
    }
  }

  add(row) {
    if (this.buffer.length >= this.maxBuffer) {
      log.warn(`Remote price buffer is full (${this.maxBuffer} rows); dropping the oldest`);
      this.buffer.splice(0, this.batchSize);
    }
    this.buffer.push(pick(row));
    if (this.buffer.length >= this.batchSize) this.flush().catch(() => {});
  }

  /** Send everything buffered. Resolves false (and keeps the rows) when the API is unreachable. */
  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      try {
        for (;;) {
          const batch = this.buffer.slice(0, this.batchSize);
          if (!batch.length) return true;
          let result;
          try {
            result = await this.postRows(batch);
          } catch (error) {
            log.warn(`Could not send ${batch.length} rows to ${this.baseUrl}: ${error.message}`);
            return false;
          }
          this.buffer.splice(0, batch.length);
          log.debug(`Sent ${result.received} rows to the remote store (${result.inserted} new)`);
        }
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  pending() {
    return this.buffer.length;
  }

  /** Stop the timer and make a last attempt to send rows. */
  async close() {
    if (this.timer) clearInterval(this.timer);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.flush()) return;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
    if (this.pending()) log.error(`${this.pending()} rows could not be sent to the remote store`);
  }
}
