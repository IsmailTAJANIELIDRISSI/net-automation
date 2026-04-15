"use strict";

const fs = require("fs");
const path = require("path");

/** Same pdf.js build as pdf-parse (must match installed pdf-parse version). */
function resolvePdfJsBuild() {
  const libDir = path.dirname(require.resolve("pdf-parse/lib/pdf-parse.js"));
  const preferred = path.join(libDir, "pdf.js/v1.10.100/build/pdf.js");
  if (fs.existsSync(preferred)) return preferred;
  const pdfJsRoot = path.join(libDir, "pdf.js");
  const vers = fs.readdirSync(pdfJsRoot).filter((d) => /^v\d/.test(d));
  if (!vers.length) {
    throw new Error("pdf.js bundle not found next to pdf-parse");
  }
  vers.sort();
  return path.join(pdfJsRoot, vers[vers.length - 1], "build/pdf.js");
}

/** Text extraction for one page — same logic as pdf-parse `render_page`. */
async function renderPageToText(page) {
  const renderOptions = {
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  };
  const textContent = await page.getTextContent(renderOptions);
  let lastY;
  let text = "";
  for (const item of textContent.items) {
    if (lastY === item.transform[5] || lastY == null) {
      text += item.str;
    } else {
      text += `\n${item.str}`;
    }
    lastY = item.transform[5];
  }
  return text;
}

/**
 * Large manifests (200+ pages): full `pdf-parse` string often buries the footer
 * or hits limits. Read **page 1** (header) and **last page** (totals) only.
 */
async function extractFirstAndLastPageTexts(dataBuffer) {
  const PDFJS = require(resolvePdfJsBuild());
  PDFJS.disableWorker = true;

  const doc = await PDFJS.getDocument(dataBuffer);

  const n = doc.numPages;
  const pageNums = n <= 1 ? [1] : [1, n];

  const texts = [];
  for (const pageNum of pageNums) {
    const page = await doc.getPage(pageNum);
    texts.push(await renderPageToText(page));
  }

  await doc.destroy();

  return {
    firstPageText: texts[0] || "",
    lastPageText: texts[texts.length - 1] || "",
    numpages: n,
  };
}

/**
 * LTA reference as used in filenames and BADR: digits-hyphen-digits (e.g. 157-54440131).
 * Tolerates suffixes like " (002)" in the filename.
 */
const LTA_REF_PATTERN = /\b(\d{1,4}-\d{6,})\b/;

function normalizeLotReference(value) {
  if (!value) return "";
  const text = String(value).trim();
  const match = text.match(/^(\d+)-(\d+)$/);
  if (!match) return text;

  const left = String(parseInt(match[1], 10));
  const right = match[2];
  return `${Number.isNaN(Number(left)) ? match[1] : left}-${right}`;
}

function extractLotReferenceFromFilename(filename) {
  const m = String(filename || "").match(LTA_REF_PATTERN);
  return m ? normalizeLotReference(m[1]) : "";
}

function normalizeManifestText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse the Temu-style manifest header (first page text):
 *   MAWB 157-54440131
 *   133Pcs 2415kg Currency:MAD
 * Compressed PDFs sometimes omit spaces: 133Pcs2415kgCurrency:MAD
 */
function extractManifestSummaryFromText(text) {
  const raw = normalizeManifestText(text);
  const out = {};

  const mawbLine = raw.match(/\bMAWB\s+(\d{1,4}-\d{6,})\b/i);
  if (mawbLine) {
    out.refNumber = normalizeLotReference(mawbLine[1]);
  } else {
    const firstRef = raw.match(LTA_REF_PATTERN);
    if (firstRef) out.refNumber = normalizeLotReference(firstRef[1]);
  }

  const metricPatterns = [
    /(\d+)\s*Pcs\s+([\d.,]+)\s*kg\s+Currency\s*:\s*([A-Za-z]{3})/i,
    /(\d+)Pcs\s*([\d.,]+)kg\s*Currency\s*:\s*([A-Za-z]{3})/i,
    /(\d+)\s*Pcs\s+([\d.,]+)\s*kg\s+Currency\s*([A-Za-z]{3})/i,
  ];
  let metrics = null;
  for (const re of metricPatterns) {
    metrics = raw.match(re);
    if (metrics) break;
  }
  if (metrics) {
    out.nombreContenant = String(parseInt(metrics[1], 10));
    out.poidTotal = String(metrics[2].replace(",", ".").trim());
    out.currency = metrics[3].toUpperCase();
  } else {
    const loose = raw.match(/(\d+)\s*Pcs\s*([\d.,]+)\s*kg/i);
    if (loose) {
      out.nombreContenant = String(parseInt(loose[1], 10));
      out.poidTotal = String(loose[2].replace(",", ".").trim());
    }
    const cur = raw.match(/Currency\s*:\s*([A-Za-z]{3})/i);
    if (cur) out.currency = cur[1].toUpperCase();
  }

  return out;
}

/**
 * First column of the manifest table is often the currency (MAD, USD, …).
 * Search full text — MAD may repeat on every row after the header block.
 */
function extractCurrencyFromTableColumn(text) {
  const m = String(text).match(/\b(MAD|USD|EUR|GBP|CHF|AED)\b/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Count all currency code occurrences across both page texts.
 * Table rows each start with the currency → they dominate the count.
 * Header has at most 1-2 references. Require > 2 votes to qualify.
 * This is the source of truth when header currency mismatches the table.
 */
function extractCurrencyFromTableRows(text) {
  const counts = {};
  // No trailing word boundary — PDF often concatenates first cell with next:
  // "USDMA1300013..." — \bUSD\b would fail because D is followed by M.
  // We only require the code is NOT preceded by another uppercase letter
  // (avoids matching e.g. "CASAUSD" or mid-word) but allow it to be followed
  // by anything (digits, letters from the next table cell, etc.).
  const re = /(?:^|[^A-Z])(MAD|USD|EUR|GBP|CHF|AED)/gim;
  let m;
  while ((m = re.exec(text)) !== null) {
    const c = m[1].toUpperCase();
    counts[c] = (counts[c] || 0) + 1;
  }
  let best = null;
  let bestCount = 2; // must appear more than twice to override header
  for (const [c, cnt] of Object.entries(counts)) {
    if (cnt > bestCount) {
      bestCount = cnt;
      best = c;
    }
  }
  return best;
}

/**
 * If triplet regex misses (odd PDF spacing), scan last lines for "a b,c d" pattern.
 * Also handles multi-line footer and concatenated numbers like "2544201858,67".
 */
function extractFooterTotalLineFallback(fullText, hints = {}) {
  const poidsHint =
    hints.poidsKg != null && String(hints.poidsKg).trim() !== ""
      ? String(parseInt(String(hints.poidsKg).replace(/[^\d]/g, ""), 10) || "")
      : "";
  const lines = String(fullText)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const scan = lines.slice(-150);

  // Helper: extract value from potentially concatenated string
  // e.g., "2544201858,67" -> we want "201858,67"
  function extractValue(str) {
    // Scan space-separated tokens right-to-left first.
    // Handles e.g. "2120  9719,03" → last token "9719,03" → 9719.03
    // without the bug caused by stripping spaces and concatenating into "21209719,03".
    const rawStr = String(str || "").trim();
    const toksV = rawStr.split(/\s+/).filter(Boolean);
    for (let ti = toksV.length - 1; ti >= 0; ti--) {
      const tm = toksV[ti].match(/^(\d{1,7})[,.](\d{2})$/);
      if (tm) return `${parseInt(tm[1], 10)}.${tm[2]}`;
    }

    const src = rawStr.replace(/\s/g, "");

    // Prefer already-isolated values (3-7 integer digits).
    // Requiring a non-digit boundary avoids slicing inside longer concatenated runs.
    const isolated = src.match(/(?:^|\D)(\d{3,7}),(\d{2})(?:\D|$)/);
    if (isolated) {
      return `${isolated[1]}.${isolated[2]}`;
    }

    // Fallback for concatenated sequences (e.g. "2544201858,67").
    const decimals = [...src.matchAll(/(\d+),(\d{2})/g)];
    if (decimals.length === 0) return null;

    const last = decimals[decimals.length - 1];
    const intPart = String(last[1] || "");
    const decPart = String(last[2] || "");

    if (intPart.length <= 7) {
      return `${intPart}.${decPart}`;
    }

    // Iterate over PREFIX lengths (3→4→5→2) rather than value lengths.
    // This correctly recovers e.g. "21209719" → prefix "212" + value 9719
    // before trying the wrong prefix "21" + value 209719.
    // Upper cap of 999999 on value prevents accepting a 7-digit wrong split.
    const prefixLengths = [3, 4, 5, 2];
    for (const pLen of prefixLengths) {
      if (intPart.length <= pLen) continue;
      const prefixStr = intPart.slice(0, pLen);
      const valueInt = intPart.slice(pLen);
      const prefixNum = parseInt(prefixStr, 10);
      const valueNum = parseInt(valueInt, 10);
      if (Number.isNaN(prefixNum) || Number.isNaN(valueNum)) continue;
      if (prefixNum <= 0 || prefixNum > 99999) continue;
      if (valueNum < 1000 || valueNum >= 1000000) continue;
      return `${valueNum}.${decPart}`;
    }

    // Last fallback: keep a bounded suffix.
    return `${parseInt(intPart.slice(-7), 10)}.${decPart}`;
  }

  // Strategy 1: triplet on same line with proper spacing
  for (let i = scan.length - 1; i >= 0; i--) {
    const line = scan[i];
    const m = line.match(/(\d+)\s+([\d\s]+,\d{2})\s+(\d+)/);
    if (!m) continue;
    if (poidsHint && String(m[3]) !== poidsHint) continue;
    return m[2].replace(/\s/g, "").replace(",", ".");
  }

  // Strategy 2: find poids on its own line, look for value nearby
  if (poidsHint) {
    for (let i = scan.length - 1; i >= 0; i--) {
      const line = scan[i].trim();
      if (line === poidsHint || line.match(new RegExp(`^${poidsHint}$`))) {
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          const prevLine = scan[j];
          const val = extractValue(prevLine);
          if (val) return val;
        }
      }
    }
  }

  // Strategy 3: find reasonable decimal value in last lines
  for (let i = scan.length - 1; i >= Math.max(0, scan.length - 20); i--) {
    const line = scan[i];
    const val = extractValue(line);
    if (val) {
      const numVal = parseFloat(val);
      if (numVal >= 100 && numVal <= 10000000) {
        return val;
      }
    }
  }

  return null;
}

/**
 * Last page footer: three values — e.g. "2781 243596,74 2530" (possibly line-broken).
 * The **second** value is Valeur totale (French decimal comma).
 * @param {string} fullText
 * @param {{ poidsKg?: string }} [hints] — third number matches header "…2530 kg" when possible
 */
function extractFooterTotalValue(fullText, hints = {}) {
  const poidsHint =
    hints.poidsKg != null && String(hints.poidsKg).trim() !== ""
      ? String(parseInt(String(hints.poidsKg).replace(/[^\d]/g, ""), 10) || "")
      : "";

  const src = String(fullText)
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/\u202f|\u2009|\u2007/g, " ")
    .replace(/，/g, ",");

  // Try single-line triplet patterns first (with proper spacing)
  const patterns = [
    /(\d+)\s+(\d{1,3}(?:\s\d{3})*,\d{2})\s+(\d+)/g,
    /(\d+)\s+(\d+,\d{2})\s+(\d+)/g,
    /(\d+)\s+(\d+\.\d{2})\s+(\d+)/g,
  ];

  const all = [];
  for (const re of patterns) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      all.push({ midRaw: m[2], third: m[3], m });
    }
  }

  if (all.length) {
    let chosen = null;
    if (poidsHint) {
      const filtered = all.filter((x) => String(x.third) === poidsHint);
      if (filtered.length) {
        chosen = filtered[filtered.length - 1];
      }
    }
    if (!chosen) {
      const scored = all.filter((x) => {
        const intPart = String(x.midRaw).replace(/\s/g, "").split(/[,.]/)[0];
        return intPart.length >= 4 && intPart.length <= 8; // reasonable value size
      });
      chosen = scored.length ? scored[scored.length - 1] : all[all.length - 1];
    }

    let mid = String(chosen.midRaw).replace(/\s/g, "");
    if (mid.includes(",")) {
      mid = mid.replace(",", ".");
    }
    return mid;
  }

  // No properly-spaced triplet found — try to extract from concatenated numbers
  // PDF sometimes outputs "2544201858,67" instead of "2544 201858,67"
  // Strategy: find text ending with poids, then parse backwards to find the decimal value

  const lines = src
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const lastLines = lines.slice(-50);

  // Helper: extract value from a chunk that may have concatenated numbers
  // e.g., "2544201858,67" -> we want "201858,67"
  function extractValueFromChunk(chunk) {
    // Scan space-separated tokens right-to-left first.
    // Handles e.g. "2120  9719,03" → last token "9719,03" → 9719.03
    // without the bug caused by stripping spaces and concatenating into "21209719,03".
    const rawChunk = String(chunk || "").trim();
    const toksC = rawChunk.split(/\s+/).filter(Boolean);
    for (let ti = toksC.length - 1; ti >= 0; ti--) {
      const tm = toksC[ti].match(/^(\d{1,7})[,.](\d{2})$/);
      if (tm) return `${parseInt(tm[1], 10)}.${tm[2]}`;
    }

    const src = rawChunk.replace(/\s/g, "");

    // Prefer already-isolated values (3-7 integer digits).
    // Non-digit boundaries prevent grabbing a middle slice from a longer run.
    const isolated = src.match(/(?:^|\D)(\d{3,7}),(\d{2})(?:\D|$)/);
    if (isolated) {
      return `${isolated[1]}.${isolated[2]}`;
    }

    // Fallback for concatenated sequences where leading digits belong to
    // a previous footer column.
    const allDecimals = [...src.matchAll(/(\d+),(\d{2})/g)];
    if (allDecimals.length > 0) {
      const last = allDecimals[allDecimals.length - 1];
      const intPart = String(last[1] || "");
      const decPart = String(last[2] || "");

      if (intPart.length <= 7) {
        return `${intPart}.${decPart}`;
      }

      // Iterate over PREFIX lengths (3→4→5→2) rather than value lengths.
      // This correctly recovers e.g. "21209719" → prefix "212" + value 9719
      // before trying the wrong prefix "21" + value 209719.
      // Upper cap of 999999 on value prevents accepting a 7-digit wrong split.
      const prefixLengths = [3, 4, 5, 2];
      for (const pLen of prefixLengths) {
        if (intPart.length <= pLen) continue;
        const prefixStr = intPart.slice(0, pLen);
        const valueInt = intPart.slice(pLen);
        const prefixNum = parseInt(prefixStr, 10);
        const valueNum = parseInt(valueInt, 10);
        if (Number.isNaN(prefixNum) || Number.isNaN(valueNum)) continue;
        if (prefixNum <= 0 || prefixNum > 99999) continue;
        if (valueNum < 1000 || valueNum >= 1000000) continue;
        return `${valueNum}.${decPart}`;
      }

      return `${parseInt(intPart.slice(-7), 10)}.${decPart}`;
    }

    return null;
  }

  // Strategy 1: Look for poids hint on its own line or at end of line
  if (poidsHint) {
    for (let i = lastLines.length - 1; i >= 0; i--) {
      const line = lastLines[i];

      // If line IS the poids or ENDS with poids
      if (line === poidsHint || line.match(new RegExp(`\\s${poidsHint}$`))) {
        // Look at previous lines for the value
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          const prevLine = lastLines[j];
          const val = extractValueFromChunk(prevLine);
          if (val) return val;
        }
      }

      // If line contains poids preceded by a decimal value
      // Pattern: "NNNN XXXXXX,XX PPPP" or "NNNNXXXXXX,XXPPPP" (concatenated)
      if (line.includes(poidsHint)) {
        // Try to find value before poids in same line
        const beforePoids = line.split(poidsHint)[0];
        const val = extractValueFromChunk(beforePoids);
        if (val) return val;
      }
    }
  }

  // Strategy 2: Find any reasonable decimal value in last lines
  for (
    let i = lastLines.length - 1;
    i >= Math.max(0, lastLines.length - 20);
    i--
  ) {
    const line = lastLines[i];
    const val = extractValueFromChunk(line);
    if (val) {
      const numVal = parseFloat(val);
      // Sanity check: value should be reasonable (100 to 10 million)
      if (numVal >= 100 && numVal <= 10000000) {
        return val;
      }
    }
  }

  return null;
}

/**
 * @param {string} pdfPath
 * @returns {Promise<{ ok: boolean, error?: string } & Record<string, string>>}
 */
async function extractManifestMetricsFromPdfFile(pdfPath) {
  const resolved = path.resolve(pdfPath);
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: "file_not_found" };
  }

  let pdfParse;
  try {
    pdfParse = require("pdf-parse");
  } catch (e) {
    return { ok: false, error: "pdf_parse_not_installed" };
  }

  try {
    const buf = fs.readFileSync(resolved);

    let firstPageText;
    let lastPageText;

    try {
      const pages = await extractFirstAndLastPageTexts(buf);
      firstPageText = pages.firstPageText;
      lastPageText = pages.lastPageText;
    } catch (pageErr) {
      const data = await pdfParse(buf);
      const fullText = String(data.text || "");
      firstPageText = fullText.slice(0, 24000);
      lastPageText = fullText.slice(-35000);
    }

    let parsed = extractManifestSummaryFromText(firstPageText);
    const partialHead =
      parsed.refNumber ||
      parsed.nombreContenant ||
      parsed.poidTotal ||
      parsed.currency;
    if (!partialHead) {
      parsed = extractManifestSummaryFromText(
        `${firstPageText}\n${lastPageText}`,
      );
    }
    // Currency: table rows are the source of truth — count occurrences across both pages.
    // Header may say MAD but every row in the table says USD; dominant count wins.
    const fullTextForCurrency = `${firstPageText}\n${lastPageText}`;
    const fromTableRows = extractCurrencyFromTableRows(fullTextForCurrency);
    if (fromTableRows) {
      parsed.currency = fromTableRows;
    } else if (!parsed.currency) {
      const fromTable = extractCurrencyFromTableColumn(firstPageText);
      if (fromTable) parsed.currency = fromTable;
    }

    let totalValue = extractFooterTotalValue(lastPageText, {
      poidsKg: parsed.poidTotal,
    });
    if (!totalValue) {
      totalValue = extractFooterTotalValue(lastPageText, {});
    }
    if (!totalValue) {
      totalValue = extractFooterTotalLineFallback(lastPageText, {
        poidsKg: parsed.poidTotal,
      });
    }
    if (!totalValue) {
      totalValue = extractFooterTotalLineFallback(lastPageText, {});
    }
    if (totalValue) {
      parsed.totalValue = totalValue;
    }
    const hasAny =
      parsed.refNumber ||
      parsed.nombreContenant ||
      parsed.poidTotal ||
      parsed.currency ||
      parsed.totalValue;
    if (!hasAny) {
      return {
        ok: false,
        error: "no_manifest_header_match",
        ...parsed,
      };
    }
    return { ok: true, ...parsed };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function isManifestFilename(name) {
  const lower = String(name).toLowerCase();
  return (
    lower.endsWith(".pdf") &&
    (lower.includes("manifest") || lower.includes("manifeste"))
  );
}

function isMawbFilename(name) {
  const lower = String(name).toLowerCase();
  return (
    lower.endsWith(".pdf") && (lower.includes("mawb") || lower.includes("lta"))
  );
}

/**
 * Prefer the original manifest PDF. Skip `*_compressed.pdf` (annex/cache copies)
 * when a non-compressed manifest exists in the same folder.
 */
function pickManifestPdf(files) {
  const candidates = files.filter(isManifestFilename);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const notCompressed = candidates.filter((f) => !/_compressed\.pdf$/i.test(f));
  const pool = notCompressed.length > 0 ? notCompressed : candidates;
  return [...pool].sort((a, b) => a.localeCompare(b, "fr"))[0];
}

function pickMawbPdf(files) {
  const candidates = files.filter(isMawbFilename);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const notCompressed = candidates.filter((f) => !/_compressed\.pdf$/i.test(f));
  const pool = notCompressed.length > 0 ? notCompressed : candidates;
  return [...pool].sort((a, b) => a.localeCompare(b, "fr"))[0];
}

module.exports = {
  LTA_REF_PATTERN,
  normalizeLotReference,
  extractLotReferenceFromFilename,
  extractManifestSummaryFromText,
  extractCurrencyFromTableColumn,
  extractFooterTotalValue,
  extractFooterTotalLineFallback,
  extractManifestMetricsFromPdfFile,
  pickManifestPdf,
  pickMawbPdf,
};
