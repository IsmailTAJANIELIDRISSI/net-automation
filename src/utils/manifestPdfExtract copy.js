/**
 * Last page footer: three values — e.g. "2781 243596,74 2530" (possibly line-broken).
 * The **second** value is Valeur totale (French decimal comma).
 *
 * ROOT CAUSE FIX: PDF.js sometimes emits the footer row without the space between
 * nbrColis and valeurTotale, yielding e.g. "2544201858,67" instead of "2544 201858,67".
 *
 * FIXED: Now properly strips the nbrColis prefix to extract the real value.
 *
 * @param {string} fullText
 * @param {{ poidsKg?: string, nbrColis?: string }} [hints]
 */
function extractFooterTotalValue(fullText, hints = {}) {
  const poidsHint =
    hints.poidsKg != null && String(hints.poidsKg).trim() !== ""
      ? String(parseInt(String(hints.poidsKg).replace(/[^\d]/g, ""), 10) || "")
      : "";

  const nbrColisHint =
    hints.nbrColis != null && String(hints.nbrColis).trim() !== ""
      ? String(parseInt(String(hints.nbrColis).replace(/[^\d]/g, ""), 10) || "")
      : "";

  const src = String(fullText)
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\u00A0/g, " ")
    .replace(/\u202f|\u2009|\u2007/g, " ")
    .replace(/，/g, ",");

  // Pattern 1: spaced thousands "201 858,67"
  // Pattern 2: plain decimal with 1-8 digits before comma "201858,67"
  // Pattern 3: dot decimal "201858.67"
  const patterns = [
    /(\d+)\s+(\d{1,3}(?:\s\d{3})*,\d{2})\s+(\d+)/g,
    /(\d+)\s+(\d{1,8},\d{2})\s+(\d+)/g,
    /(\d+)\s+(\d{1,8}\.\d{2})\s+(\d+)/g,
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
        return intPart.length >= 4 && intPart.length <= 8;
      });
      chosen = scored.length ? scored[scored.length - 1] : all[all.length - 1];
    }

    let mid = String(chosen.midRaw).replace(/\s/g, "");
    if (mid.includes(",")) {
      mid = mid.replace(",", ".");
    }
    return mid;
  }

  // ── Concatenated-token fallback (FIXED) ─────────────────────────────────
  // PDF sometimes outputs "2544201858,67" (nbrColis glued onto value)
  // We now properly extract the real value using the nbrColis hint

  const lines = src
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const lastLines = lines.slice(-50);

  /**
   * Extract a plausible total value from a raw chunk string.
   * FIXED: Uses nbrColisHint to strip the prefix and get the real value.
   */
  function extractValueFromChunk(chunk) {
    // PRIMARY FIX: Strip nbrColis prefix (e.g., "2544201858,67" -> "201858,67")
    if (nbrColisHint) {
      // Pattern: prefix followed by 4-8 digits, comma, 2 digits
      const prefixPattern = new RegExp(`${nbrColisHint}(\\d{4,8}),(\\d{2})`);
      const prefixMatch = chunk.match(prefixPattern);
      if (prefixMatch) {
        // Return the real value without the prefix
        return `${prefixMatch[1]}.${prefixMatch[2]}`;
      }

      // Also try with optional non-digit separator
      const prefixPattern2 = new RegExp(
        `${nbrColisHint}[^\\d]*(\\d{4,8}),(\\d{2})`,
      );
      const prefixMatch2 = chunk.match(prefixPattern2);
      if (prefixMatch2) {
        return `${prefixMatch2[1]}.${prefixMatch2[2]}`;
      }
    }

    // Fallback 1: Properly bounded decimal (3-8 integer digits, not adjacent to other digits)
    const bounded = chunk.match(/(?<!\d)(\d{3,8}),(\d{2})(?!\d)/);
    if (bounded) {
      // Ensure we don't have too many digits (means prefix still attached)
      if (bounded[1].length <= 8) {
        return `${bounded[1]}.${bounded[2]}`;
      }
    }

    // Fallback 2: Find last comma-decimal and take last 6-8 digits of integer part
    const allDecimals = [...chunk.matchAll(/(\d+),(\d{2})/g)];
    if (allDecimals.length > 0) {
      const last = allDecimals[allDecimals.length - 1];
      // If integer part is too long (>8 digits), take only the last 6 digits
      // This handles cases where the prefix is still attached
      let intPart = last[1];
      if (intPart.length > 8) {
        intPart = intPart.slice(-6);
      }
      if (intPart && intPart.length >= 3) {
        return `${intPart}.${last[2]}`;
      }
    }

    return null;
  }

  // Strategy 1: Look for poids hint on its own line or at end of line
  if (poidsHint) {
    for (let i = lastLines.length - 1; i >= 0; i--) {
      const line = lastLines[i];

      if (line === poidsHint || line.match(new RegExp(`\\s${poidsHint}$`))) {
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          const val = extractValueFromChunk(lastLines[j]);
          if (val) return val;
        }
      }

      if (line.includes(poidsHint)) {
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
    const val = extractValueFromChunk(lastLines[i]);
    if (val) {
      const numVal = parseFloat(val);
      if (numVal >= 100 && numVal <= 10000000) {
        return val;
      }
    }
  }

  return null;
}
