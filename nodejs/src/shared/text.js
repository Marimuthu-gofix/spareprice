// Text and price helpers shared by the scraper and the dashboard.
// Ported from spareprice.py / dashboard.py.

export const PRICE_RE = /(₹|Rs\.?|INR|USD|\$|EUR|€|GBP|£)?\s*(\d[\d,]*(?:\.\d{1,2})?)/i;
const CURRENCY_PREFIX_PRICE_RE = /(₹|Rs\.?|INR|USD|\$|EUR|€|GBP|£)\s*(\d[\d,]*(?:\.\d{1,2})?)/gi;
const CURRENCY_SUFFIX_PRICE_RE = /(\d[\d,]*(?:\.\d{1,2})?)\s*(Rs\.?|INR|USD|EUR|GBP)/gi;

export function normalizeSpace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function normalizeCurrency(currency) {
  if (!currency) return null;
  const lower = currency.toLowerCase();
  if (lower.startsWith("rs") || currency.toUpperCase() === "INR" || currency === "₹") return "INR";
  if (currency === "$") return "USD";
  if (currency === "€") return "EUR";
  if (currency === "£") return "GBP";
  return currency.toUpperCase();
}

/** Earliest currency+amount pair in the text: {index, currency, amount} or null. */
export function findCurrencyPriceMatch(text) {
  const matches = [];
  for (const match of text.matchAll(CURRENCY_PREFIX_PRICE_RE)) {
    matches.push({ index: match.index, currency: match[1], amount: match[2] });
  }
  for (const match of text.matchAll(CURRENCY_SUFFIX_PRICE_RE)) {
    matches.push({ index: match.index, currency: match[2], amount: match[1] });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => a.index - b.index);
  return matches[0];
}

/** Returns [currency, amount] with nulls when nothing parses. */
export function parsePrice(text) {
  const currencyMatch = findCurrencyPriceMatch(text);
  if (currencyMatch) {
    return [normalizeCurrency(currencyMatch.currency), Number(currencyMatch.amount.replace(/,/g, ""))];
  }
  const match = PRICE_RE.exec(text);
  if (!match) return [null, null];
  return [normalizeCurrency(match[1]), Number(match[2].replace(/,/g, ""))];
}

export function coercePriceValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const [, parsed] = parsePrice(String(value));
  return parsed;
}

export function formatPriceText(currency, priceValue) {
  const label = !currency || currency === "INR" ? "INR" : currency;
  const integer = Number.isInteger(priceValue);
  return `${label} ${priceValue.toLocaleString("en-US", { minimumFractionDigits: integer ? 0 : 2, maximumFractionDigits: integer ? 0 : 2 })}`;
}

const NON_SPARE_PART_MARKERS = [
  "repair, inspection", "service fee", "service type", "software installation", "software upgrade", "return without repair",
];

export function isNonSparePart(part) {
  const lower = part.toLowerCase();
  return NON_SPARE_PART_MARKERS.some((marker) => lower.includes(marker));
}

/** "Battery ₹1,390" -> {part, priceText, priceValue, currency} or null. */
export function parseCatalogPriceRow(text) {
  const clean = normalizeSpace(text);
  const match = findCurrencyPriceMatch(clean);
  if (!match) return null;
  const [currency, value] = parsePrice(clean);
  if (value === null) return null;
  const part = normalizeSpace(clean.slice(0, match.index).replace(/^[\s:\-|]+|[\s:\-|]+$/g, ""));
  if (!part) return null;
  return { part, priceText: clean, priceValue: value, currency };
}

export function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
}

export function cssEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
