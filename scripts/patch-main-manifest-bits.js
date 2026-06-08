/**
 * Patch: add qteFacturee and _source (Vision) to the success log bits in main.js
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "electron", "main.js");
let content = fs.readFileSync(FILE, "utf8");
const CRLF = "\r\n";

// ── Target block ──────────────────────────────────────────────────────────────
const OLD = [
  "          const bits = [",
  "            manifestPdfExtract.refNumber &&",
  "              `r\u00e9f ${manifestPdfExtract.refNumber}`,",
  "            manifestPdfExtract.nombreContenant &&",
  "              `${manifestPdfExtract.nombreContenant} colis`,",
  "            manifestPdfExtract.poidTotal &&",
  "              `${manifestPdfExtract.poidTotal} kg`,",
  "            manifestPdfExtract.currency &&",
  "              `devise ${manifestPdfExtract.currency}`,",
  "            manifestPdfExtract.totalValue &&",
  "              `valeur ${manifestPdfExtract.totalValue}`,",
  "          ]",
  "            .filter(Boolean)",
  '            .join(", ");',
  "          sendLog(",
  '            "info",',
  '            "Manifeste",',
  '            `[${entry.name}] PDF "${manifeste}" \u2014 extrait${bits ? `: ${bits}` : ""}`,',
  "          );",
].join(CRLF);

const NEW = [
  "          const bits = [",
  "            manifestPdfExtract.refNumber &&",
  "              `r\u00e9f ${manifestPdfExtract.refNumber}`,",
  "            manifestPdfExtract.nombreContenant &&",
  "              `${manifestPdfExtract.nombreContenant} colis`,",
  "            manifestPdfExtract.poidTotal &&",
  "              `${manifestPdfExtract.poidTotal} kg`,",
  "            manifestPdfExtract.currency &&",
  "              `devise ${manifestPdfExtract.currency}`,",
  "            manifestPdfExtract.totalValue &&",
  "              `valeur ${manifestPdfExtract.totalValue}`,",
  "            manifestPdfExtract.qteFacturee &&",
  "              `qteFactur\u00e9e ${manifestPdfExtract.qteFacturee}`,",
  "            manifestPdfExtract._source &&",
  "              `(via ${manifestPdfExtract._source})`,",
  "          ]",
  "            .filter(Boolean)",
  '            .join(", ");',
  "          sendLog(",
  '            "info",',
  '            "Manifeste",',
  '            `[${entry.name}] PDF "${manifeste}" \u2014 extrait${bits ? `: ${bits}` : ""}`,',
  "          );",
].join(CRLF);

if (!content.includes(OLD)) {
  console.error("ERROR: target block not found — no changes made.");
  process.exit(1);
}

fs.writeFileSync(FILE, content.replace(OLD, NEW), "utf8");
console.log(
  "OK: main.js patched — qteFacturee + _source added to success log.",
);
