"use strict";

/**
 * Shared Gemini API retry helpers.
 *
 * Strategy per error type:
 *   503 UNAVAILABLE  — model is overloaded; exponential back-off on the SAME
 *                      model (5 s → 10 s → 20 s, up to MAX_503_RETRIES).
 *   429 RESOURCE_EXHAUSTED — quota hit; the API embeds an exact retryDelay
 *                      ("58s"). We parse it, wait that long (+1 s safety), then
 *                      retry the SAME model once.  If it fails again we skip to
 *                      the next model so we don't block forever.
 *   404 / 400        — wrong model name or bad request; skip to next model
 *                      immediately (no point waiting).
 *   anything else    — skip to next model.
 */

const MAX_503_RETRIES = 3; // per model: 5 s, 10 s, 20 s

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a Gemini API error (whose .message is a JSON string) and return useful
 * metadata so the retry loop knows what to do.
 *
 * @param {Error} e
 * @returns {{ code: number|null, status: string|null, retryDelayMs: number|null }}
 */
function parseGeminiError(e) {
  try {
    const body = JSON.parse(e.message);
    const err = body.error || {};
    // The API may embed a RetryInfo detail with a "retryDelay" field like "58s"
    // or "58.140814857s".
    const retryInfo = (err.details || []).find(
      (d) => d["@type"] && d["@type"].includes("RetryInfo"),
    );
    let retryDelayMs = null;
    if (retryInfo?.retryDelay) {
      const secs = parseFloat(retryInfo.retryDelay); // strip trailing "s"
      if (!isNaN(secs)) retryDelayMs = Math.ceil(secs * 1000);
    }
    return { code: err.code ?? null, status: err.status ?? null, retryDelayMs };
  } catch {
    return { code: null, status: null, retryDelayMs: null };
  }
}

/**
 * Call client.models.generateContent with automatic retry for transient errors.
 *
 * @param {object}   client     — GoogleGenAI instance
 * @param {string}   modelName  — e.g. "gemini-2.5-flash"
 * @param {object}   params     — passed directly to generateContent (minus model)
 * @param {Function} log        — logging function (string) => void
 * @returns {Promise<object>}   — the generateContent response
 * @throws if the error is non-retryable or retries are exhausted
 */
async function geminiCallWithRetry(client, modelName, params, log) {
  let retries503 = 0;
  let retries429 = 0;

  while (true) {
    try {
      return await client.models.generateContent({
        model: modelName,
        ...params,
      });
    } catch (e) {
      const { code, retryDelayMs } = parseGeminiError(e);

      // ── 503: model overloaded ─────────────────────────────────────────────
      if (code === 503 && retries503 < MAX_503_RETRIES) {
        const wait = 5000 * Math.pow(2, retries503); // 5 s, 10 s, 20 s
        const waitCapped = Math.min(wait, 25000);
        log(
          `${modelName} surchargé (503) — attente ${Math.round(waitCapped / 1000)} s ` +
            `(tentative ${retries503 + 1}/${MAX_503_RETRIES})...`,
        );
        await sleep(waitCapped);
        retries503++;
        continue;
      }

      // ── 429: quota / rate limit ───────────────────────────────────────────
      if (code === 429 && retries429 < 1) {
        // Respect the API's own retry hint; add 1 s buffer; cap at 70 s.
        const wait = Math.min((retryDelayMs ?? 60_000) + 1_000, 70_000);
        log(
          `${modelName} quota dépassé (429) — attente ${Math.round(wait / 1000)} s ` +
            `(délai API: ${retryDelayMs != null ? Math.round(retryDelayMs / 1000) + " s" : "inconnu"})...`,
        );
        await sleep(wait);
        retries429++;
        continue;
      }

      // ── Non-retryable (404, 400, exhausted retries) ───────────────────────
      throw e;
    }
  }
}

module.exports = { sleep, parseGeminiError, geminiCallWithRetry };
