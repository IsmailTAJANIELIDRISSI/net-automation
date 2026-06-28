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
