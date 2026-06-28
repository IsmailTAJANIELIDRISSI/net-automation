"use strict";

const fs = require("fs");
const path = require("path");

// ── Gemini model fallback order (mirrors Python GEMINI_MODEL_FALLBACKS) ──────
const GEMINI_MODEL_FALLBACKS = [
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];

// ── Retry helper (handles 503 back-off + 429 quota wait) ─────────────────────
const { geminiCallWithRetry } = require("./geminiRetry");

// ── Generic logistics words that must NOT be used as discriminating fragments ─
// These words appear in many company names and cause false-positive matches.
// Only company-specific words (e.g. FIXLINK, MAERSK, BOLLORÉ) should discriminate.
const GENERIC_LOGISTICS_WORDS = new Set([
  "INTERNATIONAL",
  "LOGISTICS",
  "TRADING",
  "SHIPPING",
  "ENTERPRISE",
  "ENTERPRISES",
  "GLOBAL",
  "CARGO",
  "FREIGHT",
  "SUPPLY",
  "CHAIN",
  "GROUP",
  "EXPRESS",
  "INDUSTRY",
  "INDUSTRIES",
  "TECHNOLOGY",
  "ELECTRONIC",
  "ELECTRONICS",
  "MANUFACTURE",
  "MANUFACTURING",
  "FACTORY",
  "LIMITED",
  "COMPANY",
  "IMPORT",
  "EXPORT",
  "FORWARDER",
  "FORWARDING",
  "TRANSPORT",
  "TRANSPORTATION",
]);

// ── Text that cannot be a shipper name ───────────────────────────────────────
const EXCLUDE_PATTERNS = [
  /^TEL[:\s]/i,
  /^FAX[:\s]/i,
  /^EMAIL[:\s]/i,
  /@/,
  /^(RM|NO|APT|ROOM|FLOOR|SUITE|UNIT)\s*\d/i,
  /P\.?O\.?\s*BOX/i,
  /MED\s+AFRICA\s+LOGISTICS/i,
  /MOROCCO/i,
  /CASABLANCA/i,
  /FREIGHT\s+(PREPAID|COLLECT)/i,
  /AIR\s+WAYBILL/i,
  /ISSUED\s+BY/i,
  /NOT\s+NEG[AO]T/i, // "Not Negotiable" / "Not negotlable" (OCR variant)
  /HS\s+CODE/i,
  /ATTACHED\s+LIST/i,
  /^\d{3,}/,
  // ── MAWB form-field column headers ──────────────────────────────────────────
  /consignee['']?s?\s+name/i,
  /shipper['']?s?\s+(name|account|reference)/i,
  /name\s+and\s+address/i,
  /it\s+is\s+agreed/i,
  /conditions\s+of\s+contract/i,
  /shipper['']?s?\s+attention/i,
  /carrier['']?s?\s+limitation/i,
  /copies\s+\d/i,
  /originals?\s+and\s+have/i,
  /apparent\s+good\s+order/i,
  /SUBJECT\s+TO\s+THE\s+CONDITIONS/i,
  // ── Air Waybill boilerplate sentences ─────────────────────────────────────────
  /limitation\s+of\s+liability/i,
  /declaring\s+a\s+higher\s+value/i,
  /\(incl\.\s*dimensions/i,
  /nature\s+and\s+quantity/i,
  /paying\s+a\s+supplemental/i,
];

const COMPANY_INDICATORS = [
  "LOGISTICS",
  "INTERNATIONAL",
  "CO.,LTD",
  "CO. ,LTD",
  "CO LTD",
  "CO.,",
  "LTD",
  "LIMITED",
  "INC",
  "CORP",
  "GROUP",
  "EXPRESS",
  "SHIPPING",
  "TRADING",
  "INDUSTRY",
  "INDUSTRIES",
  "SUPPLY",
  "FREIGHT",
  "CARGO",
  "IMPORT",
  "EXPORT",
  "TECHNOLOGY",
  "TECH",
  "ELECTRONIC",
  "MANUFACTURE",
  "FACTORY",
  "ENTERPRISE",
  "ENTERPRISES",
];

// Short purely-alphabetic indicators (≤ 4 chars) appear as substrings of common
// English words: INC→increase, LTD→(rare), CORP→(rare), TECH→technical.
// These require a word-boundary check; longer / symbol-containing indicators do not.
const WORD_BOUNDARY_SHORT = new Set(
  COMPANY_INDICATORS.filter((ind) => ind.length <= 4 && /^\w+$/.test(ind)),
);

/** Returns true if the line looks like a company name */
function mightBeCompany(line) {
  if (!line || line.length < 5) return false;
  // Long sentences are never company names — cap at 90 characters.
  if (line.length > 90) return false;
  const upper = line.toUpperCase();
  return COMPANY_INDICATORS.some((ind) =>
    WORD_BOUNDARY_SHORT.has(ind)
      ? new RegExp(`\\b${ind}\\b`).test(upper)
      : upper.includes(ind),
  );
}

/** Returns true if the line should be excluded */
function shouldExclude(line) {
  return EXCLUDE_PATTERNS.some((p) => p.test(line));
}

/** Clean OCR artefacts and normalize spacing */
function cleanLine(line) {
  return line
    .replace(/\bCO\s+\.,\s*LTD\b/gi, "CO.,LTD")
    .replace(/\bCO\s*\.\s*,\s*LTD\b/gi, "CO.,LTD")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── Gemini verification (mirrors verify_shipper_with_gemini in Python) ────────

/**
 * Call Gemini to pick / clean the best shipper name from candidates.
 * Returns the final_name string, or null on failure.
 */
async function verifyShipperWithGemini(candidates, knownCompanies, log) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log("GEMINI_API_KEY absent — verification IA ignoree");
    return null;
  }

  let genai;
  try {
    genai = require("@google/genai");
  } catch {
    log("@google/genai non installe — verification IA ignoree");
    return null;
  }

  const client = new genai.GoogleGenAI({ apiKey });

  const prompt = `You are an expert in logistics company name identification and OCR error correction.
Here are all potential company names extracted from a shipping document (prioritized by fuzzy matching):
${JSON.stringify(candidates, null, 2)}

KNOWN COMPANIES DATABASE:
${JSON.stringify(knownCompanies.slice(0, 25), null, 2)}

CRITICAL INSTRUCTIONS:
1. OCR ERROR CORRECTION: Fix "LOGIGHES"->"LOGISTICS", "+76"->"LTD", "C0"->"CO", etc.
   Remove leading non-letter characters: "; COMPANY" -> "COMPANY"
2. Accept ALL company types (TRADING, LOGISTICS, MANUFACTURING, etc.)
3. Fuzzy match candidates against DB (>70% similarity = match). Candidates at START of list are pre-ranked.
4. NEVER select "MED AFRICA LOGISTICS" (consignee, not shipper).
5. If candidate contains company name + address, extract ONLY the company name.

OUTPUT FORMAT (exact JSON, no markdown fences):
{
    "reasoning": "step-by-step analysis",
    "matched_company": "best database match or null",
    "is_new_company": true,
    "selected_candidate": "chosen candidate from list",
    "final_name": "final cleaned company name"
}`;

  let lastError = null;
  for (const modelName of GEMINI_MODEL_FALLBACKS) {
    try {
      log(`Appel Gemini (${modelName})...`);
      const response = await geminiCallWithRetry(
        client,
        modelName,
        { contents: prompt },
        log,
      );

      let responseText = "";
      if (response && typeof response.text === "string" && response.text) {
        responseText = response.text;
      } else if (response?.candidates?.[0]?.content?.parts) {
        responseText = response.candidates[0].content.parts
          .filter((p) => !p.thought)
          .map((p) => p.text || "")
          .join("\n");
      }

      responseText = responseText.trim();
      if (responseText.startsWith("```")) {
        const start = responseText.indexOf("{");
        const end = responseText.lastIndexOf("}") + 1;
        responseText =
          start !== -1 ? responseText.slice(start, end) : responseText;
      }

      const parsed = JSON.parse(responseText);
      const finalName = parsed.final_name || null;
      if (finalName) {
        log(
          `Gemini resultat: "${finalName}" (matched: ${parsed.matched_company ?? "null"}, nouveau: ${parsed.is_new_company})`,
        );
      }
      return finalName;
    } catch (e) {
      log(`Gemini ${modelName} echoue: ${e.message}`);
      lastError = e;
    }
  }

  log(`Tous les modeles Gemini ont echoue: ${lastError?.message}`);
  return null;
}

/**
 * Reconcile the MAWB Total Prepaid: the printed total and the summed prepaid
 * charge lines must agree. Hand-filled scans often misplace/misread the total,
 * so we only TRUST the freight when the two cross-check (≈ within 0.5 %).
 * Returns { fretValue, fretConfident } — fretValue is null when unsure, which
 * forces manual entry. For a customs figure, "unsure → ask the human" is safer
 * than guessing.
 */
function reconcileFret(totalRaw, sumRaw, log = () => {}) {
  const num = (v) => {
    if (v == null) return null;
    const s = String(v).replace(/[^\d.]/g, ""); // strip currency code / commas
    if (!s) return null;
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  };
  const total = num(totalRaw);
  const sum = num(sumRaw);
  if (total != null && sum != null) {
    const tol = Math.max(1, Math.max(total, sum) * 0.005); // 0.5 % or 1 unit
    if (Math.abs(total - sum) <= tol) {
      return { fretValue: total.toFixed(2), fretConfident: true };
    }
    log(
      `Fret INCERTAIN: total imprimé (${total}) ≠ somme des charges (${sum}) — saisie manuelle requise`,
    );
    return { fretValue: null, fretConfident: false };
  }
  log(
    `Fret non vérifiable (total=${total ?? "?"}, somme=${sum ?? "?"}) — saisie manuelle requise`,
  );
  return { fretValue: null, fretConfident: false };
}

/**
 * Scanned-PDF fallback: send raw PDF bytes to Gemini Vision.
 * Extracts shipper name, currency, total prepaid, pieces and weight in ONE call.
 * Returns { shipperName, mawbCurrency, fretValue, fretConfident, nbrPieces, grossWeight }.
 */
async function extractVisionMeta(pdfPath, knownCompanies, log) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log(
      "PDF scanné détecté mais GEMINI_API_KEY absent — impossible d'utiliser la vision IA",
    );
    return { shipperName: null, mawbCurrency: null, fretValue: null, fretConfident: false, nbrPieces: null, grossWeight: null };
  }

  let genai;
  try {
    genai = require("@google/genai");
  } catch {
    log("@google/genai non installé — vision IA ignorée");
    return { shipperName: null, mawbCurrency: null, fretValue: null, fretConfident: false, nbrPieces: null, grossWeight: null };
  }

  const client = new genai.GoogleGenAI({ apiKey });
  const pdfBase64 = fs.readFileSync(pdfPath).toString("base64");

  const prompt = `This is an Air Waybill (MAWB) document. Extract the following values:

1. SHIPPER NAME — from the "Shipper's Name and Address" box (top-left of the form).
   - Return ONLY the company name (no address, no street, no phone, no email).
   - Fix obvious OCR errors ("C0" → "CO", "LOGIGHCS" → "LOGISTICS").
   - NEVER return "MED AFRICA LOGISTICS" — that is the consignee.
   - If it closely matches a known company below, return the canonical form.
   Known companies: ${JSON.stringify(knownCompanies.slice(0, 25))}

2. CURRENCY — the 3-letter currency code in the "Currency" field (e.g. CNY, USD, HKD, EUR).

3. TOTAL PREPAID — return TWO numbers so they can be cross-checked (hand-filled scans
   often misplace/misread the total):
   a) "total_prepaid": the printed Total Prepaid figure at the bottom-left of the charges
      grid (in, or just below/next to, the "Total Prepaid" cell — read it even if it sits
      slightly outside the cell).
   b) "charges_sum": add up EVERY prepaid charge line you can read — Weight Charge +
      Valuation Charge + Tax + Total Other Charges Due Agent + Total Other Charges Due
      Carrier — and return that exact sum (e.g. 130860.89 + 11222.20 = 142083.09).
   Both as plain numbers with the decimal point, no thousands separators, no currency code.
   Use null for a value you genuinely cannot read, or for a fully "collect" shipment.

4. NO OF PIECES — the integer in the "No. of Pieces RCP" column of the cargo line, at the
   bottom-left of the goods table (e.g. 121). Plain integer, no other text.

5. GROSS WEIGHT — the number in the "Gross Weight" column of the cargo line, next to the
   pieces count (e.g. 2311). Plain number, no unit ("kg"), no thousands separators.

Respond in this EXACT JSON (no markdown fences):
{
  "shipper_name": "COMPANY NAME OR null",
  "currency": "CNY",
  "total_prepaid": "142083.09",
  "charges_sum": "142083.09",
  "no_of_pieces": "121",
  "gross_weight": "2311"
}`;

  let lastError = null;
  for (const modelName of GEMINI_MODEL_FALLBACKS) {
    try {
      log(`PDF scanné — appel Gemini Vision (${modelName})...`);
      const response = await geminiCallWithRetry(
        client,
        modelName,
        {
          contents: [
            {
              parts: [
                {
                  inlineData: { mimeType: "application/pdf", data: pdfBase64 },
                },
                { text: prompt },
              ],
            },
          ],
        },
        log,
      );

      let responseText = "";
      if (response && typeof response.text === "string" && response.text) {
        responseText = response.text;
      } else if (response?.candidates?.[0]?.content?.parts) {
        responseText = response.candidates[0].content.parts
          .filter((p) => !p.thought)
          .map((p) => p.text || "")
          .join("\n");
      }

      responseText = responseText.trim();
      if (responseText.startsWith("```")) {
        const start = responseText.indexOf("{");
        const end = responseText.lastIndexOf("}") + 1;
        responseText =
          start !== -1 ? responseText.slice(start, end) : responseText;
      }

      const parsed = JSON.parse(responseText);
      const { fretValue, fretConfident } = reconcileFret(
        parsed.total_prepaid,
        parsed.charges_sum,
        log,
      );
      const result = {
        shipperName: parsed.shipper_name || null,
        mawbCurrency: parsed.currency || null,
        fretValue,
        fretConfident,
        nbrPieces: parsed.no_of_pieces || null,
        grossWeight: parsed.gross_weight || null,
      };
      log(
        `Gemini Vision résultat: expéditeur="${result.shipperName}" devise=${result.mawbCurrency} fret=${result.fretValue} (confiance=${result.fretConfident}) colis=${result.nbrPieces} poids=${result.grossWeight}`,
      );
      return result;
    } catch (e) {
      log(`Gemini Vision ${modelName} échoué: ${e.message}`);
      lastError = e;
    }
  }

  log(`Tous les modèles Gemini Vision ont échoué: ${lastError?.message}`);
  return { shipperName: null, mawbCurrency: null, fretValue: null, fretConfident: false, nbrPieces: null, grossWeight: null };
}

// ── Currency / fret extraction for text-based PDFs ────────────────────────────

const KNOWN_CURRENCY_RE =
  /\b(CNY|USD|HKD|EUR|GBP|JPY|CHF|SGD|AUD|CAD|MYR|THB|AED|SAR|KWD|QAR)\b/i;
// Same codes without \b — for flattened text where currency is embedded (e.g. "CMNSVUSDN")
const KNOWN_CURRENCY_RE_LOOSE =
  /(CNY|USD|HKD|EUR|GBP|JPY|CHF|SGD|AUD|CAD|MYR|THB|AED|SAR|KWD|QAR)/i;

/**
 * Best-effort extraction of currency and total-prepaid from raw PDF text.
 * Returns { mawbCurrency, fretValue } — either may be null.
 */
function extractMetaFromText(text, log) {
  let mawbCurrency = null;
  let fretValue = null;

  // Currency: prefer match near the "Currency" label, else scan full text.
  // Try strict \b match first; fall back to loose match for flattened text (e.g. "CMNSVUSDN").
  const currencyLabelIdx = text.search(/\bcurrency\b/i);
  const searchWindow =
    currencyLabelIdx >= 0
      ? text.slice(currencyLabelIdx, currencyLabelIdx + 120)
      : text;
  const codeMatch =
    searchWindow.match(KNOWN_CURRENCY_RE) ||
    searchWindow.match(KNOWN_CURRENCY_RE_LOOSE);
  if (codeMatch) {
    mawbCurrency = codeMatch[1].toUpperCase();
    log(`Devise trouvée dans texte: ${mawbCurrency}`);
  }

  // Total Prepaid: label followed (same line or next line) by a decimal number.
  // pdf-parse sometimes flattens the layout so the label may not appear — handled below.
  // Allow comma in the numeric part so "TWD577,610.00" → match "577,610.00"
  // (currency prefix is consumed by the preceding [^\n] groups; comma stripped after).
  const prepaidMatch = text.match(
    /total\s+prepaid[^\n]{0,80}\n?[^\n]{0,40}?(\d[\d, .]*\.\d{2})/i,
  );
  if (prepaidMatch) {
    fretValue = prepaidMatch[1].replace(/[\s,]/g, ""); // strip spaces and thousands commas
    log(`Total Prepaid trouvé dans texte: ${fretValue}`);
  }

  return { mawbCurrency, fretValue };
}

/**
 * Supplemental Gemini Vision call used when the text regex couldn't find the
 * currency/fret (and to read pieces/weight, which the text layout rarely yields).
 * Returns { mawbCurrency, fretValue, fretConfident, nbrPieces, grossWeight }.
 */
async function supplementCurrencyFretViaVision(pdfPath, log) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log("GEMINI_API_KEY absent — complément Vision ignoré");
    return {
      mawbCurrency: null,
      fretValue: null,
      nbrPieces: null,
      grossWeight: null,
    };
  }

  let genai;
  try {
    genai = require("@google/genai");
  } catch {
    return {
      mawbCurrency: null,
      fretValue: null,
      nbrPieces: null,
      grossWeight: null,
    };
  }

  const client = new genai.GoogleGenAI({ apiKey });
  const pdfBase64 = fs.readFileSync(pdfPath).toString("base64");

  const prompt = `This is an Air Waybill (MAWB). Extract these values:
1. CURRENCY — the 3-letter ISO code in the "Currency" column (e.g. CNY, USD, TWD, HKD).
2. TOTAL PREPAID — return TWO numbers so they can be cross-checked (hand-filled scans often
   misplace/misread the total):
   a) "total_prepaid": the printed Total Prepaid figure at the bottom-left of the charges grid
      (in, or just below/next to, the "Total Prepaid" cell — read it even if slightly outside).
   b) "charges_sum": add up EVERY prepaid charge line you can read — Weight Charge + Valuation
      Charge + Tax + Total Other Charges Due Agent + Total Other Charges Due Carrier — and
      return that exact sum (e.g. 130860.89 + 11222.20 = 142083.09).
   STRICT for BOTH numbers: strip currency-code prefixes, remove thousands-separator commas,
   keep the decimal point and 2 decimals (e.g. "575770.00", NOT "57577000"). Use null for a
   value you cannot read, or for a fully "collect" shipment.
3. NO OF PIECES — the integer in the "No. of Pieces RCP" column of the cargo line (e.g. 121).
   Plain integer, no other text.
4. GROSS WEIGHT — the number in the "Gross Weight" column of the cargo line (e.g. 2311).
   Plain number, no unit ("kg"), no thousands separators.

Respond ONLY in this exact JSON (no markdown):
{"currency": "TWD", "total_prepaid": "142083.09", "charges_sum": "142083.09", "no_of_pieces": "121", "gross_weight": "2311"}`;

  for (const modelName of GEMINI_MODEL_FALLBACKS) {
    try {
      log(`Complément Vision devise+fret (${modelName})...`);
      const response = await geminiCallWithRetry(
        client,
        modelName,
        {
          contents: [
            {
              parts: [
                {
                  inlineData: { mimeType: "application/pdf", data: pdfBase64 },
                },
                { text: prompt },
              ],
            },
          ],
        },
        log,
      );

      let responseText = "";
      if (response && typeof response.text === "string" && response.text) {
        responseText = response.text;
      } else if (response?.candidates?.[0]?.content?.parts) {
        responseText = response.candidates[0].content.parts
          .filter((p) => !p.thought)
          .map((p) => p.text || "")
          .join("\n");
      }
      responseText = responseText.trim();
      if (responseText.startsWith("```")) {
        const s = responseText.indexOf("{"),
          e = responseText.lastIndexOf("}") + 1;
        responseText = s !== -1 ? responseText.slice(s, e) : responseText;
      }
      const parsed = JSON.parse(responseText);
      const { fretValue, fretConfident } = reconcileFret(
        parsed.total_prepaid,
        parsed.charges_sum,
        log,
      );
      const result = {
        mawbCurrency: parsed.currency || null,
        fretValue,
        fretConfident,
        nbrPieces: parsed.no_of_pieces || null,
        grossWeight: parsed.gross_weight || null,
      };
      log(
        `Complément Vision: devise=${result.mawbCurrency} fret=${result.fretValue} (confiance=${result.fretConfident}) colis=${result.nbrPieces} poids=${result.grossWeight}`,
      );
      return result;
    } catch (e) {
      log(`Complément Vision ${modelName} échoué: ${e.message}`);
    }
  }
  return {
    mawbCurrency: null,
    fretValue: null,
    nbrPieces: null,
    grossWeight: null,
  };
}

/**
 * Main extraction entry point.
 * Returns { shipperName, mawbCurrency, fretValue } — any field may be null.
 */
async function extractMawbMeta(pdfPath, knowCompaniesPath, log = () => {}) {
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`MAWB PDF not found: ${pdfPath}`);
  }

  try {
    require("dotenv").config();
  } catch {
    /* optional */
  }

  let pdfParse;
  try {
    pdfParse = require("pdf-parse");
  } catch {
    throw new Error("pdf-parse not installed");
  }

  let knownCompanies = [];
  if (fs.existsSync(knowCompaniesPath)) {
    try {
      knownCompanies = JSON.parse(fs.readFileSync(knowCompaniesPath, "utf8"));
    } catch {
      /* ignore */
    }
  }

  const buf = fs.readFileSync(pdfPath);
  const data = await pdfParse(buf);
  const text = String(data.text || "");
  log(`PDF lu: ${text.length} caracteres extraits`);
  log(
    `Texte brut (500 premiers chars): "${text
      .slice(0, 500)
      .replace(/\n/g, "")
      .replace(/\s{3,}/g, " ")}"`,
  );

  // ── Scanned PDF: single Gemini Vision call extracts all 3 fields ─────────
  if (text.replace(/\s/g, "").length < 50) {
    log("PDF scanné détecté (< 50 chars) — utilisation de Gemini Vision");
    return await extractVisionMeta(pdfPath, knownCompanies, log);
  }

  // ── Text-based PDF ────────────────────────────────────────────────────────
  const allLines = text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 3);

  // Currency via regex; the regex Total Prepaid is a single UNVERIFIED read, so
  // it is NOT trusted for the freight (customs figure) — the Vision reconciliation
  // below is the source of truth for fretValue.
  let { mawbCurrency } = extractMetaFromText(text, log);
  let fretValue = null;
  let fretConfident = false;
  let nbrPieces = null;
  let grossWeight = null;

  // Always cross-check the freight + read pieces/weight via Vision (text layout
  // rarely yields a verifiable Total Prepaid). fretValue stays null unless the
  // total↔charges-sum reconciliation is confident → uncertain MAWBs require
  // manual entry instead of a silently-wrong customs value.
  {
    log("Complément Gemini Vision (fret vérifié + colis/poids)…");
    const supplement = await supplementCurrencyFretViaVision(pdfPath, log);
    if (!mawbCurrency && supplement.mawbCurrency)
      mawbCurrency = supplement.mawbCurrency;
    if (supplement.fretConfident) {
      fretValue = supplement.fretValue;
      fretConfident = true;
    }
    if (supplement.nbrPieces != null) nbrPieces = supplement.nbrPieces;
    if (supplement.grossWeight != null) grossWeight = supplement.grossWeight;
  }

  const anchorPatterns = [
    /shipper['']?s?\s+name\s+and\s+address/i,
    /nom\s+et\s+adresse\s+de\s+l['']exp[eé]diteur/i,
    /\bshipper\b/i,
    /\bexp[eé]diteur\b/i,
  ];

  for (const pattern of anchorPatterns) {
    const match = text.match(pattern);
    if (!match) continue;

    // Use a large window (1500 chars) because two-column PDFs concatenate ALL
    // column header labels before the actual cell content, so the company name
    // may be several hundred chars after the "Shipper's Name and Address" label.
    const afterAnchor = text
      .slice(
        match.index + match[0].length,
        match.index + match[0].length + 1500,
      )
      .replace(/\r/g, "\n");
    const lines = afterAnchor
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 3 && !pattern.test(l));

    // Only keep lines that look like company names AND are not excluded labels.
    // If none pass, the anchor window didn't contain real content — fall through
    // to the full-document scan rather than feeding garbage to Gemini.
    const candidates = lines
      .filter((l) => !shouldExclude(l) && mightBeCompany(l))
      .slice(0, 5);

    if (candidates.length === 0) {
      log(
        `Anchor trouvee mais aucun candidat societe dans la fenetre — passage au scan complet`,
      );
      continue;
    }

    log(`Anchor trouvee -> candidats: ${JSON.stringify(candidates)}`);

    const shipperName = await resolveCandidate(candidates, knownCompanies, log);
    if (shipperName)
      return { shipperName, mawbCurrency, fretValue, fretConfident, nbrPieces, grossWeight };
  }

  log(
    `Aucun anchor trouve — scan de ${allLines.length} lignes pour pattern societe`,
  );
  const candidates = allLines.filter(
    (l) => mightBeCompany(l) && !shouldExclude(l),
  );
  log(`Candidats societe trouves: ${JSON.stringify(candidates)}`);

  if (candidates.length === 0) {
    log("Aucun candidat societe trouve — retour null");
    return { shipperName: null, mawbCurrency, fretValue, fretConfident, nbrPieces, grossWeight };
  }

  const shipperName = await resolveCandidate(candidates, knownCompanies, log);
  return { shipperName, mawbCurrency, fretValue, fretConfident, nbrPieces, grossWeight };
}

/** Backward-compat wrapper — returns just the shipper name string. */
async function extractShipperName(pdfPath, knowCompaniesPath, log = () => {}) {
  const { shipperName } = await extractMawbMeta(
    pdfPath,
    knowCompaniesPath,
    log,
  );
  return shipperName;
}

async function resolveCandidate(candidates, knownCompanies, log) {
  const knownMatch = matchAgainstKnown(candidates, knownCompanies, log);
  if (knownMatch) return knownMatch;

  if (candidates.length > 0) {
    log(
      `Aucune correspondance haute confiance — envoi a Gemini (${candidates.length} candidats)`,
    );
    const geminiResult = await verifyShipperWithGemini(
      candidates,
      knownCompanies,
      log,
    );
    if (geminiResult) return geminiResult;
  }

  const companyLine = candidates.find(mightBeCompany) || candidates[0];
  if (companyLine) {
    const cleaned = cleanLine(companyLine);
    log(`Fallback premiere ligne: "${cleaned}"`);
    return cleaned || null;
  }

  return null;
}

function matchAgainstKnown(candidates, companies, log) {
  if (!Array.isArray(companies) || companies.length === 0) return null;

  log(`known_companies: ${companies.length} entrees`);

  for (const candidate of candidates) {
    const candidateUpper = candidate.toUpperCase();
    // Strip parenthesized content (city/location qualifiers like "(SHANGHAI)") before
    // fragment matching — they must not trigger false positives on unrelated companies.
    const candidateStripped = candidateUpper
      .replace(/\([^)]*\)/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    for (const name of companies) {
      const nameUpper = String(name).toUpperCase().trim();

      // Distinctive = ≥5 chars AND not a generic logistics word.
      // Only these words discriminate between companies (e.g. FIXLINK, MAERSK).
      const allFragments = nameUpper
        .split(/[\s,.()']+/)
        .filter((f) => f.length >= 5);
      const distinctive = allFragments.filter(
        (f) => !GENERIC_LOGISTICS_WORDS.has(f),
      );

      if (distinctive.length >= 1) {
        // ALL distinctive fragments must be present in the candidate (parentheses stripped).
        // City names inside "()" are excluded so "(SHANGHAI)" never matches "SHANGHAI KING...".
        const allPresent = distinctive.every((f) =>
          candidateStripped.includes(f),
        );
        if (allPresent) {
          log(
            `Correspondance known_companies: "${name}" (${distinctive.length} fragments distinctifs: ${distinctive.join(", ")})`,
          );
          return name;
        }
      } else {
        // Company name has no distinctive word (all-generic name) — require strict containment.
        if (candidateStripped.includes(nameUpper)) {
          log(`Correspondance stricte known_companies: "${name}"`);
          return name;
        }
      }
    }
  }

  log("Aucune correspondance haute confiance dans known_companies");
  return null;
}

module.exports = { extractShipperName, extractMawbMeta };
