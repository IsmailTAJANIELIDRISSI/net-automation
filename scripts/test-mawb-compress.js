"use strict";
/**
 * CLI test for compressMawbGhostscript.
 * Usage:
 *   node scripts/test-mawb-compress.js "C:\path\to\MAWB.pdf"
 */

const path = require("path");
const fs = require("fs");
const { compressMawbGhostscript } = require("../src/utils/compressPdfChain");

const inputPath = process.argv[2];

if (!inputPath) {
  console.error("Usage: node scripts/test-mawb-compress.js <path-to-mawb.pdf>");
  process.exit(1);
}

const resolved = path.resolve(inputPath);
if (!fs.existsSync(resolved)) {
  console.error(`File not found: ${resolved}`);
  process.exit(1);
}

const log = {
  info: (msg) => console.log(`[INFO ] ${msg}`),
  warn: (msg) => console.warn(`[WARN ] ${msg}`),
};

const inSize = fs.statSync(resolved).size;
console.log(`\nInput : ${resolved}`);
console.log(
  `Size  : ${(inSize / 1024).toFixed(1)} KB (${(inSize / (1024 * 1024)).toFixed(3)} MB)\n`,
);

compressMawbGhostscript(resolved, log)
  .then(({ uploadPath, mode }) => {
    const outSize = fs.statSync(uploadPath).size;
    const reduction = (((inSize - outSize) / inSize) * 100).toFixed(1);
    console.log(`\n✓ Done`);
    console.log(`  Mode     : ${mode}`);
    console.log(`  Output   : ${uploadPath}`);
    console.log(
      `  Size     : ${(outSize / 1024).toFixed(1)} KB (${(outSize / (1024 * 1024)).toFixed(3)} MB)`,
    );
    if (mode === "compressed") {
      console.log(`  Reduction: ${reduction}%`);
    }
  })
  .catch((err) => {
    console.error(`\n✗ Error: ${err.message}`);
    process.exit(1);
  });
