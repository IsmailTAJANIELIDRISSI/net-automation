// Fields every LTA must have filled before it can be launched (individually or
// in a batch). Used by AcheminementCard (to disable "Lancer") and App.handleRunAll
// (to skip incomplete LTAs) so the rule lives in one place.

export const REQUIRED_FIELDS = [
  ["scelle1", "Scellé #1"],
  ["scelle2", "Scellé #2"],
  ["nombreContenant", "Nb. contenant"],
  ["poidTotal", "Poids total"],
  ["totalValue", "Valeur totale"],
];

/**
 * Returns the labels of the required fields that are empty on this acheminement.
 * An empty array means the LTA has all obligatory info and can be launched.
 * Partiel LTAs additionally require "Valeur fret MAWB" — it's only auto-filled
 * when the MAWB Total Prepaid was confidently reconciled; otherwise the operator
 * must type it (a customs figure we won't guess).
 */
export function getMissingRequiredFields(ach) {
  const fields = [...REQUIRED_FIELDS];
  if (ach?.partiel) fields.push(["fretValue", "Valeur fret MAWB"]);
  return fields.filter(([key]) => {
    const v = ach?.[key];
    return v === undefined || v === null || String(v).trim() === "";
  }).map(([, label]) => label);
}

// Sanity bounds for the declared "Valeur totale", by currency. A value outside
// the range (often a bad manifest read) must be confirmed by the operator before
// the LTA is processed — for both DS Combinée and Partiel LTAs. No bounds for
// other currencies (e.g. EUR) → no check.
export const VALUE_RANGE_LIMITS = {
  MAD: { min: 150000, max: 450000 },
  USD: { min: 4000, max: 40000 },
};

function parseAmount(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return NaN;
  return Number(String(raw).replace(/\s/g, "").replace(",", "."));
}

/**
 * Returns an issue descriptor when the acheminement's Valeur totale is outside
 * the expected range for its currency, or null when it's fine / uncheckable.
 * The operator can override it (see `valueRangeAck`).
 */
export function getValueRangeIssue(ach) {
  const currency = String(ach?.currency || "MAD").toUpperCase();
  const limits = VALUE_RANGE_LIMITS[currency];
  if (!limits) return null; // currency without defined bounds → skip
  const value = parseAmount(ach?.totalValue);
  if (!Number.isFinite(value)) return null;
  if (value >= limits.min && value <= limits.max) return null;

  const fmt = (n) => n.toLocaleString("fr-FR");
  const tooLow = value < limits.min;
  return {
    currency,
    value,
    min: limits.min,
    max: limits.max,
    tooLow,
    message: `Valeur totale ${fmt(value)} ${currency} ${
      tooLow ? "inférieure au minimum" : "supérieure au maximum"
    } attendu (plage ${fmt(limits.min)} – ${fmt(limits.max)} ${currency}).`,
  };
}
