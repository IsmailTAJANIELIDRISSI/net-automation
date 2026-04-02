#!/usr/bin/env node
/**
 * CLI wrapper for src/utils/compressPdfChain.js (same logic as Portnet annex prep).
 *
 * Usage:
 *   node scripts/compress-pdf-chain.js <input.pdf> <output.pdf>
 */

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { compressPdfForAnnex } = require("../src/utils/compressPdfChain");

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

async function main() {
  const inputArg = process.argv[2];
  const outputArg = process.argv[3];
  if (!inputArg || !outputArg) {
    console.error(
      "Usage: node scripts/compress-pdf-chain.js <input.pdf> <output.pdf>",
    );
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  const outputPath = path.resolve(outputArg);

  try {
    const { uploadPath, mode } = await compressPdfForAnnex(inputPath, console);
    if (path.resolve(uploadPath) !== path.resolve(outputPath)) {
      fs.copyFileSync(uploadPath, outputPath);
    }
    if (uploadPath !== inputPath) {
      try {
        fs.unlinkSync(uploadPath);
      } catch {}
    }
    const sz = fs.statSync(outputPath).size;
    console.log(`Saved: ${outputPath} (${mb(sz)} MB) mode=${mode}`);
    if (sz > 2 * 1024 * 1024) {
      console.error("WARNING: output is still > 2 MB.");
      process.exit(3);
    }
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("exceeds 2 MB") || msg.includes("still exceeds")) {
      console.error(msg);
      process.exit(3);
    }
    console.error(e);
    process.exit(1);
  }
}

main();
