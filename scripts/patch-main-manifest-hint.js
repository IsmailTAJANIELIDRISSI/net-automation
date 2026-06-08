/**
 * One-shot patch: enhances the manifest warn log in electron/main.js
 * to show an actionable hint based on the error type.
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "electron", "main.js");
let content = fs.readFileSync(FILE, "utf8");

// The exact target block (CRLF-terminated, as in the source file)
const CRLF = "\r\n";
const OLD_LINES = [
  "        } else {",
  "          sendLog(",
  '            "warn",',
  '            "Manifeste",',
  '            `[${entry.name}] PDF "${manifeste}" \u2014 pas d\u2019en-t\u00eate exploitable (${manifestPdfExtract?.error || "inconnu"})`,',
  "          );",
  "        }",
].join(CRLF);

const NEW_LINES = [
  "        } else {",
  '          const errDetails = manifestPdfExtract?.error || "inconnu";',
  '          const hint = errDetails.includes("Invalid PDF")',
  '            ? " \u2014 le fichier PDF a une structure non support\u00e9e par le lecteur int\u00e9gr\u00e9"',
  '            : errDetails === "no_manifest_header_match"',
  '              ? " \u2014 le PDF est lisible mais ne contient pas l\u2019en-t\u00eate MAWB/Pcs/kg attendu"',
  '              : errDetails === "gemini_vision_all_models_failed"',
  '                ? " \u2014 PDF illisible et Vision Gemini a aussi \u00e9chou\u00e9"',
  '                : "";',
  "          sendLog(",
  '            "warn",',
  '            "Manifeste",',
  '            `[${entry.name}] PDF "${manifeste}" \u2014 pas d\u2019en-t\u00eate exploitable (${errDetails})${hint}`,',
  "          );",
  "        }",
].join(CRLF);

if (!content.includes(OLD_LINES)) {
  console.error("ERROR: target block not found in main.js — no changes made.");
  process.exit(1);
}

const patched = content.replace(OLD_LINES, NEW_LINES);
fs.writeFileSync(FILE, patched, "utf8");
console.log("OK: main.js patched with enhanced manifest warn hint.");
