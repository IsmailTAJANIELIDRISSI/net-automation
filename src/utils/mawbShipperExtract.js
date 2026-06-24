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
 * Scanned-PDF fallback: send raw PDF bytes to Gemini Vision.
 * Extracts shipper name, currency, AND total prepaid in ONE call.
 * Returns { shipperName, mawbCurrency, fretValue } — any field may be null.
 */
async function extractVisionMeta(pdfPath, knownCompanies, log) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log(
      "PDF scanné détecté mais GEMINI_API_KEY absent — impossible d'utiliser la vision IA",
    );
    return { shipperName: null, mawbCurrency: null, fretValue: null };
  }

  let genai;
  try {
    genai = require("@google/genai");
  } catch {
    log("@google/genai non installé — vision IA ignorée");
    return { shipperName: null, mawbCurrency: null, fretValue: null };
  }

  const client = new genai.GoogleGenAI({ apiKey });
  const pdfBase64 = fs.readFileSync(pdfPath).toString("base64");

  const prompt = `This is an Air Waybill (MAWB) document. Extract the following three values:

1. SHIPPER NAME — from the "Shipper's Name and Address" box (top-left of the form).
   - Return ONLY the company name (no address, no street, no phone, no email).
   - Fix obvious OCR errors ("C0" → "CO", "LOGIGHCS" → "LOGISTICS").
   - NEVER return "MED AFRICA LOGISTICS" — that is the consignee.
   - If it closely matches a known company below, return the canonical form.
   Known companies: ${JSON.stringify(knownCompanies.slice(0, 25))}

2. CURRENCY — the 3-letter currency code in the "Currency" field (e.g. CNY, USD, HKD, EUR).

3. TOTAL PREPAID — the total PREPAID charges, printed at the bottom-left of the charges
   grid. It equals the prepaid Weight Charge total plus Valuation Charge, Tax, Total Other
   Charges Due Agent and Total Other Charges Due Carrier (e.g. weight 143258.89 + other
   charges due carrier 11810.00 = 155068.89). The figure is shown in — or just below/next
   to — the "Total Prepaid" cell; READ that printed number, do NOT treat the cell as blank
   just because the amount sits slightly outside its borders.
   - Return a plain number with the decimal point, no thousands separators, no currency code
     (e.g. "155068.89").
   - Return null ONLY for a fully "collect" shipment where no prepaid amount is printed.

Respond in this EXACT JSON (no markdown fences):
{
  "shipper_name": "COMPANY NAME OR null",
  "currency": "CNY",
  "total_prepaid": "131555.40"
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
      const result = {
        shipperName: parsed.shipper_name || null,
        mawbCurrency: parsed.currency || null,
        fretValue: parsed.total_prepaid || null,
      };
      log(
        `Gemini Vision résultat: expéditeur="${result.shipperName}" devise=${result.mawbCurrency} fret=${result.fretValue}`,
      );
      return result;
    } catch (e) {
      log(`Gemini Vision ${modelName} échoué: ${e.message}`);
      lastError = e;
    }
  }

  log(`Tous les modèles Gemini Vision ont échoué: ${lastError?.message}`);
  return { shipperName: null, mawbCurrency: null, fretValue: null };
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
 * Supplemental Gemini Vision call used only when regex couldn’t find currency or fret.
 * Asks ONLY for currency + total_prepaid (no shipper name needed here).
 * Returns { mawbCurrency, fretValue }.
 */
async function supplementCurrencyFretViaVision(pdfPath, log) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log("GEMINI_API_KEY absent — complément Vision ignoré");
    return { mawbCurrency: null, fretValue: null };
  }

  let genai;
  try {
    genai = require("@google/genai");
  } catch {
    return { mawbCurrency: null, fretValue: null };
  }

  const client = new genai.GoogleGenAI({ apiKey });
  const pdfBase64 = fs.readFileSync(pdfPath).toString("base64");

  const prompt = `This is an Air Waybill (MAWB). Extract exactly two values:
1. CURRENCY — the 3-letter ISO code in the "Currency" column (e.g. CNY, USD, TWD, HKD).
2. TOTAL PREPAID — the total PREPAID charges at the bottom-left of the charges grid. It
   equals the prepaid Weight Charge total plus Valuation Charge, Tax and Total Other Charges
   (Due Agent + Due Carrier) — e.g. 143258.89 + 11810.00 = 155068.89. It is shown in, or just
   below/next to, the "Total Prepaid" cell; READ that printed number even if it sits slightly
   outside the cell — do not call it blank.
   STRICT RULES for the number:
   - Strip any currency code prefix (e.g. "TWD575,770.00" → "575770.00").
   - Remove ALL thousands-separator commas (e.g. "575,770.00" → "575770.00").
   - KEEP the decimal point and exactly 2 decimal places (e.g. "575770.00", NOT "57577000").
   - Return null ONLY for a fully "collect" shipment with no prepaid amount printed.

Respond ONLY in this exact JSON (no markdown):
{"currency": "TWD", "total_prepaid": "575770.00"}`;

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
      // Strip thousands-separator commas so the UI receives a plain decimal.
      // Also guard against Gemini returning an integer without decimal (e.g. "57577000"
      // instead of "575770.00") by detecting values that look like they lost their
      // decimal point: any integer with ≥ 5 digits where the last two should be cents.
      const rawFret = parsed.total_prepaid || null;
      let fretValue = rawFret ? String(rawFret).replace(/,/g, "") : null;
      if (fretValue && /^\d+$/.test(fretValue) && fretValue.length >= 5) {
        // Gemini dropped the decimal point — reinsert before last 2 digits.
        fretValue = `${fretValue.slice(0, -2)}.${fretValue.slice(-2)}`;
        log(`Fret: décimale manquante détectée — corrigé en ${fretValue}`);
      }
      const result = {
        mawbCurrency: parsed.currency || null,
        fretValue,
      };
      log(
        `Complément Vision: devise=${result.mawbCurrency} fret=${result.fretValue}`,
      );
      return result;
    } catch (e) {
      log(`Complément Vision ${modelName} échoué: ${e.message}`);
    }
  }
  return { mawbCurrency: null, fretValue: null };
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

  // Extract currency and fret value via regex first
  let { mawbCurrency, fretValue } = extractMetaFromText(text, log);

  // If regex missed either field, supplement with a targeted Gemini Vision call.
  // This handles PDFs where pdf-parse flattens the layout (no "Total Prepaid" label in text).
  if (!mawbCurrency || !fretValue) {
    log(
      `Régex incomplet (devise=${mawbCurrency ?? "null"}, fret=${fretValue ?? "null"}) — complément Gemini Vision`,
    );
    const supplement = await supplementCurrencyFretViaVision(pdfPath, log);
    if (!mawbCurrency && supplement.mawbCurrency)
      mawbCurrency = supplement.mawbCurrency;
    if (!fretValue && supplement.fretValue) fretValue = supplement.fretValue;
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
    if (shipperName) return { shipperName, mawbCurrency, fretValue };
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
    return { shipperName: null, mawbCurrency, fretValue };
  }

  const shipperName = await resolveCandidate(candidates, knownCompanies, log);
  return { shipperName, mawbCurrency, fretValue };
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
