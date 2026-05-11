"use strict";

/**
 * Fetch the MAD exchange rate for a given currency.
 * Three-provider fallback chain:
 *   1. frankfurter.dev BAM provider (official Moroccan customs rate)
 *   2. frankfurter.dev blended rate
 *   3. openexchangerates.org cross-rate via USD base
 *
 * @param {string} fromCurrency  - ISO 4217 code, e.g. "USD", "EUR", "HKD"
 * @returns {Promise<number>}    - MAD rate (1 unit of fromCurrency = X MAD)
 */
async function fetchMADRate(fromCurrency) {
  const OXR_APP_ID =
    process.env.OXR_APP_ID || "2da90db00995499ea8ff537a94caf80c";
  const currency = String(fromCurrency).toUpperCase().trim();

  if (currency === "MAD") return 1;

  // ── 1. BAM (official Moroccan customs rate) ─────────────────────────────
  try {
    const r = await fetch(
      `https://api.frankfurter.dev/v2/rate/${encodeURIComponent(currency)}/MAD?providers=BAM`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (r.ok) {
      const data = await r.json();
      if (typeof data?.rate === "number" && data.rate > 0) {
        return data.rate;
      }
    }
  } catch {
    // provider unavailable — fall through
  }

  // ── 2. frankfurter.dev blended ──────────────────────────────────────────
  try {
    const r = await fetch(
      `https://api.frankfurter.dev/v2/rate/${encodeURIComponent(currency)}/MAD`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (r.ok) {
      const data = await r.json();
      if (typeof data?.rate === "number" && data.rate > 0) {
        return data.rate;
      }
    }
  } catch {
    // provider unavailable — fall through
  }

  // ── 3. openexchangerates.org cross-rate via USD base ────────────────────
  try {
    const r = await fetch(
      `https://openexchangerates.org/api/latest.json?app_id=${OXR_APP_ID}&symbols=${encodeURIComponent(currency)},MAD`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (r.ok) {
      const data = await r.json();
      const fromRate = data?.rates?.[currency];
      const madRate = data?.rates?.MAD;
      if (fromRate && madRate && fromRate > 0) {
        return madRate / fromRate;
      }
    }
  } catch {
    // all providers failed
  }

  throw new Error(
    `Could not fetch MAD exchange rate for ${currency} — all providers failed`,
  );
}

/**
 * Rounding rule per BADR spec:
 *   decimal ≥ 0.5 → Math.ceil
 *   decimal < 0.5 → Math.floor
 *
 * @param {number} value
 * @returns {number}
 */
function roundBADR(value) {
  const decimal = value - Math.floor(value);
  return decimal >= 0.5 ? Math.ceil(value) : Math.floor(value);
}

module.exports = { fetchMADRate, roundBADR };
