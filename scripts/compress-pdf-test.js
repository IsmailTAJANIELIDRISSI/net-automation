#!/usr/bin/env node
"use strict";

require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const MAX_BYTES = 2 * 1024 * 1024;
const GS_TIMEOUT_MS = Math.max(
  Number(process.env.PORTNET_GS_TIMEOUT_MS || 180000),
  180000,
);
const GS_TIMEOUT_PER_MB_MS = Math.max(
  Number(process.env.PORTNET_GS_TIMEOUT_PER_MB_MS || 12000),
  5000,
);

function sizeMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function isLikelyValidPdf(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 32) return false;

    const fd = fs.openSync(filePath, "r");
    try {
      const head = Buffer.alloc(8);
      fs.readSync(fd, head, 0, head.length, 0);
      if (!head.toString("latin1").startsWith("%PDF-")) return false;

      const tailLen = Math.min(4096, stat.size);
      const tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, stat.size - tailLen);
      return tail.toString("latin1").includes("%%EOF");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function resolveGhostscriptExecutables() {
  const envPath = String(process.env.PORTNET_GS_PATH || "").trim();
  const candidates = [];
  if (envPath) candidates.push(envPath);

  if (process.platform === "win32") {
    const pf64 =
      process.env.ProgramW6432 ||
      process.env.ProgramFiles ||
      "C:\\Program Files";
    const pf32 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const known = [
      path.join(pf64, "gs", "gs10.05.1", "bin", "gswin64c.exe"),
      path.join(pf64, "gs", "gs10.04.0", "bin", "gswin64c.exe"),
      path.join(pf64, "gs", "gs10.03.1", "bin", "gswin64c.exe"),
      path.join(pf64, "gs", "gs10.03.0", "bin", "gswin64c.exe"),
      path.join(pf64, "gs", "gs10.02.1", "bin", "gswin64c.exe"),
      path.join(pf64, "gs", "gs10.01.2", "bin", "gswin64c.exe"),
      path.join(pf64, "gs", "gs10.01.1", "bin", "gswin64c.exe"),
      path.join(pf64, "gs", "gs10.01.0", "bin", "gswin64c.exe"),
      path.join(pf64, "gs", "gs10.00.0", "bin", "gswin64c.exe"),
      path.join(pf32, "gs", "gs10.05.1", "bin", "gswin32c.exe"),
    ];
    for (const p of known) if (fs.existsSync(p)) candidates.push(p);
  }

  candidates.push("gswin64c", "gswin32c", "gs");
  return [...new Set(candidates)];
}

function isIlovePdfLimitError(err) {
  const text = String(err?.message || "").toLowerCase();
  return (
    text.includes("limit") ||
    text.includes("quota") ||
    text.includes("remaining files") ||
    text.includes("insufficient credits") ||
    text.includes("too many requests") ||
    text.includes("402") ||
    text.includes("rate limit")
  );
}

// ─── Standard iLovePDF compress (extreme) ───────────────────────────────────
async function compressViaIlove(filePath, label, publicKey, secretKey) {
  const ILovePDFApi = require("@ilovepdf/ilovepdf-nodejs");
  const ILovePDFFile = require("@ilovepdf/ilovepdf-nodejs/ILovePDFFile");

  const api = new ILovePDFApi(publicKey, secretKey);
  const task = api.newTask("compress");

  await task.start();
  await task.addFile(new ILovePDFFile(filePath));
  await task.process({ compression_level: "extreme" });
  const data = await task.download();

  if (!Buffer.isBuffer(data) || data.length < 32) {
    throw new Error("iLovePDF download is empty/invalid");
  }

  const outPath = path.join(
    os.tmpdir(),
    `pdf_test_ilove_${label}_${Date.now()}_${path.basename(filePath)}`,
  );
  fs.writeFileSync(outPath, data);
  if (!isLikelyValidPdf(outPath))
    throw new Error("iLovePDF returned invalid PDF");
  return outPath;
}

// ─── Nuclear iLovePDF: PDF → JPEG pages → PDF (rasterisation) ───────────────
//
// This is what PDFCandy's "maximum" compression does. It rasterises every
// page into a low-quality JPEG then rebuilds the PDF from those images.
// Vector text/fonts are gone, but the file gets tiny.
//
async function compressViaIloveNuclear(filePath, label, publicKey, secretKey) {
  const ILovePDFApi = require("@ilovepdf/ilovepdf-nodejs");
  const ILovePDFFile = require("@ilovepdf/ilovepdf-nodejs/ILovePDFFile");
  const AdmZip = require("adm-zip"); // install once: npm i adm-zip

  const api = new ILovePDFApi(publicKey, secretKey);
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `ilove_nuclear_${label}_`),
  );

  // ── Step 1: PDF → JPEG pages ──────────────────────────────────────────────
  console.log(`  iLovePDF nuclear (${label}): step 1 – PDF → JPEG pages…`);
  const taskPdf2Jpg = api.newTask("pdfjpg");
  await taskPdf2Jpg.start();
  await taskPdf2Jpg.addFile(new ILovePDFFile(filePath));
  // pdfjpg_mode "pages" converts every page; no DPI param in the free API
  // but the resulting JPEGs are already low-res enough for this purpose.
  await taskPdf2Jpg.process({ pdfjpg_mode: "pages" });
  const zipData = await taskPdf2Jpg.download();

  if (!Buffer.isBuffer(zipData) || zipData.length < 4) {
    throw new Error("iLovePDF pdfjpg returned empty data");
  }

  // ── Unzip the page images ─────────────────────────────────────────────────
  const zip = new AdmZip(zipData);
  const entries = zip
    .getEntries()
    .filter((e) => /\.(jpg|jpeg)$/i.test(e.entryName))
    .sort((a, b) =>
      a.entryName.localeCompare(b.entryName, undefined, { numeric: true }),
    );

  if (entries.length === 0)
    throw new Error("iLovePDF pdfjpg zip contains no JPEG pages");

  const imagePaths = [];
  for (const entry of entries) {
    const imgPath = path.join(tmpDir, entry.entryName.replace(/[\\/]/g, "_"));
    fs.writeFileSync(imgPath, entry.getData());
    imagePaths.push(imgPath);
  }
  console.log(
    `  iLovePDF nuclear (${label}): extracted ${imagePaths.length} page(s)`,
  );

  // ── Step 2: JPEG pages → PDF (batched in chunks of 50 to avoid 400 limit) ─
  // A fresh ILovePDFApi instance is created per chunk because the auth token
  // in a single instance expires during long operations (-> 401 mid-run).
  const CHUNK_SIZE = 50;
  const chunkPdfPaths = [];
  const totalChunks = Math.ceil(imagePaths.length / CHUNK_SIZE);

  for (let i = 0; i < imagePaths.length; i += CHUNK_SIZE) {
    const chunk = imagePaths.slice(i, i + CHUNK_SIZE);
    const chunkIdx = Math.floor(i / CHUNK_SIZE) + 1;
    const chunkLabel = `${chunkIdx}/${totalChunks}`;
    console.log(
      `  iLovePDF nuclear (${label}): step 2 – chunk ${chunkLabel} (${chunk.length} pages) -> PDF...`,
    );

    // Fresh API instance each chunk to avoid session-token expiry (401)
    const chunkApi = new ILovePDFApi(publicKey, secretKey);
    const taskImg2Pdf = chunkApi.newTask("imagepdf");

    try {
      await taskImg2Pdf.start();
      for (const imgPath of chunk) {
        await taskImg2Pdf.addFile(new ILovePDFFile(imgPath));
      }
      await taskImg2Pdf.process({
        orientation: "portrait",
        margin: 0,
        pagesize: "fit",
        merge_after: true,
      });
      const chunkData = await taskImg2Pdf.download();
      if (!Buffer.isBuffer(chunkData) || chunkData.length < 32) {
        throw new Error(`chunk ${chunkLabel} returned empty data`);
      }
      const chunkPath = path.join(
        tmpDir,
        `chunk_${String(i).padStart(6, "0")}.pdf`,
      );
      fs.writeFileSync(chunkPath, chunkData);
      if (!isLikelyValidPdf(chunkPath))
        throw new Error(`chunk ${chunkLabel} produced invalid PDF`);
      chunkPdfPaths.push(chunkPath);
    } catch (err) {
      // If we already have some completed chunks, do a partial merge rather
      // than throwing and losing all completed work.
      if (chunkPdfPaths.length > 0) {
        console.warn(
          `  iLovePDF nuclear (${label}): chunk ${chunkLabel} failed (${err.message}) – merging ${chunkPdfPaths.length} completed chunk(s).`,
        );
        break;
      }
      throw err; // nothing done yet – bubble up so caller can try partner
    }
  }

  // ── Cleanup temp images ───────────────────────────────────────────────────
  for (const p of imagePaths) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }

  // ── Step 3: merge chunk PDFs if more than one chunk ──────────────────────
  let pdfData;
  if (chunkPdfPaths.length === 1) {
    pdfData = fs.readFileSync(chunkPdfPaths[0]);
  } else {
    console.log(
      `  iLovePDF nuclear (${label}): step 3 – merging ${chunkPdfPaths.length} chunk PDFs...`,
    );
    const mergeApi = new ILovePDFApi(publicKey, secretKey);
    const taskMerge = mergeApi.newTask("merge");
    await taskMerge.start();
    for (const chunkPath of chunkPdfPaths) {
      await taskMerge.addFile(new ILovePDFFile(chunkPath));
    }
    await taskMerge.process();
    pdfData = await taskMerge.download();
  }

  // ── Cleanup chunk PDFs ────────────────────────────────────────────────────
  for (const p of chunkPdfPaths) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmdirSync(tmpDir);
  } catch {
    /* ignore */
  }

  if (!Buffer.isBuffer(pdfData) || pdfData.length < 32) {
    throw new Error("iLovePDF nuclear final PDF is empty/invalid");
  }

  const outPath = path.join(
    os.tmpdir(),
    `pdf_test_ilove_nuclear_${label}_${Date.now()}_${path.basename(filePath)}`,
  );
  fs.writeFileSync(outPath, pdfData);
  if (!isLikelyValidPdf(outPath))
    throw new Error("iLovePDF nuclear returned invalid PDF");
  return outPath;
}

// ─── Ghostscript compress ────────────────────────────────────────────────────
async function compressViaGhostscript(filePath, sizeBytes, options = {}) {
  const ultraBw = options.ultraBw === true;
  // "nuclear" = grayscale + very aggressive downsampling (max squeeze, text still OK)
  const nuclear = options.nuclear === true;

  const timeoutMs = Math.max(
    GS_TIMEOUT_MS,
    Math.ceil(sizeBytes / (1024 * 1024)) * GS_TIMEOUT_PER_MB_MS,
  );
  const candidates = resolveGhostscriptExecutables();
  let bestPath = null;
  let bestSize = Number.POSITIVE_INFINITY;

  for (const exe of candidates) {
    const outPath = path.join(
      os.tmpdir(),
      `pdf_test_gs_${Date.now()}_${path.basename(filePath)}`,
    );
    try {
      let gsArgs;

      if (nuclear) {
        // Maximum squeeze: convert to grayscale + very low image resolution.
        // Text/vectors remain crisp (they're not rasterised by GS), only
        // embedded images get crushed. Usually gets 30-50 % more reduction
        // on top of the iLovePDF extreme pass.
        gsArgs = [
          "-sDEVICE=pdfwrite",
          "-dCompatibilityLevel=1.4",
          "-dPDFSETTINGS=/screen",
          // Convert colour → grayscale (big win on colour scans/photos)
          "-sColorConversionStrategy=Gray",
          "-dProcessColorModel=/DeviceGray",
          // Use JPEG (DCT) encoding for images — much smaller than Flate
          "-dAutoFilterColorImages=false",
          "-dAutoFilterGrayImages=false",
          "-dColorImageFilter=/DCTEncode",
          "-dGrayImageFilter=/DCTEncode",
          "-dMonoImageFilter=/CCITTFaxEncode",
          // Aggressive downsampling
          "-dDownsampleColorImages=true",
          "-dDownsampleGrayImages=true",
          "-dDownsampleMonoImages=true",
          "-dColorImageResolution=25",
          "-dGrayImageResolution=25",
          "-dMonoImageResolution=100",
          "-dDetectDuplicateImages=true",
          "-dCompressFonts=true",
          "-dSubsetFonts=true",
          "-dNOPAUSE",
          "-dQUIET",
          "-dBATCH",
          `-sOutputFile=${outPath}`,
          filePath,
        ];
      } else if (ultraBw) {
        gsArgs = [
          "-sDEVICE=pdfwrite",
          "-dCompatibilityLevel=1.4",
          "-dPDFSETTINGS=/screen",
          "-dAutoFilterColorImages=false",
          "-dAutoFilterGrayImages=false",
          "-dColorImageFilter=/FlateEncode",
          "-dGrayImageFilter=/FlateEncode",
          "-dMonoImageFilter=/CCITTFaxEncode",
          "-dDownsampleColorImages=true",
          "-dDownsampleGrayImages=true",
          "-dDownsampleMonoImages=true",
          "-dColorImageResolution=35",
          "-dGrayImageResolution=35",
          "-dMonoImageResolution=150",
          "-dDetectDuplicateImages=true",
          "-dCompressFonts=true",
          "-dSubsetFonts=true",
          "-dNOPAUSE",
          "-dQUIET",
          "-dBATCH",
          `-sOutputFile=${outPath}`,
          filePath,
        ];
      } else {
        gsArgs = [
          "-sDEVICE=pdfwrite",
          "-dCompatibilityLevel=1.4",
          "-dPDFSETTINGS=/screen",
          "-dDownsampleColorImages=true",
          "-dDownsampleGrayImages=true",
          "-dDownsampleMonoImages=true",
          "-dColorImageResolution=50",
          "-dGrayImageResolution=50",
          "-dMonoImageResolution=200",
          "-dDetectDuplicateImages=true",
          "-dCompressFonts=true",
          "-dSubsetFonts=true",
          "-dNOPAUSE",
          "-dQUIET",
          "-dBATCH",
          `-sOutputFile=${outPath}`,
          filePath,
        ];
      }

      await execFileAsync(exe, gsArgs, { timeout: timeoutMs });

      if (!fs.existsSync(outPath) || !isLikelyValidPdf(outPath)) continue;
      const outSize = fs.statSync(outPath).size;
      if (outSize < bestSize) {
        bestSize = outSize;
        bestPath = outPath;
      }
      if (outSize <= MAX_BYTES) return outPath;
    } catch (err) {
      const stderr = String(err?.stderr || "");
      const missing =
        err?.code === "ENOENT" ||
        stderr.includes("not recognized") ||
        stderr.includes("No such file or directory");
      if (missing) break;
    }
  }
  return bestPath;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const input = process.argv[2];
  const output = process.argv[3];
  const ultraBw = process.argv.includes("--ultra-bw");
  if (!input || !output) {
    console.error(
      'Usage: node scripts/compress-pdf-test.js "input.pdf" "output.pdf" [--ultra-bw]',
    );
    process.exit(2);
  }

  const inputPath = path.resolve(input);
  const outputPath = path.resolve(output);
  if (!fs.existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`);
    process.exit(2);
  }
  if (!isLikelyValidPdf(inputPath)) {
    console.error(`Input is not a valid PDF: ${inputPath}`);
    process.exit(2);
  }

  const inputSize = fs.statSync(inputPath).size;
  console.log(`Input: ${inputPath}`);
  console.log(`Size: ${sizeMB(inputSize)} MB`);
  console.log("Target: <= 2.00 MB");
  if (ultraBw) {
    console.log("Mode: ultra-bw (very aggressive, may reduce readability)");
  }

  if (inputSize <= MAX_BYTES) {
    fs.copyFileSync(inputPath, outputPath);
    console.log("Already below limit. Copied.");
    process.exit(0);
  }

  const accounts = [];
  if (process.env.ILOVEPDF_PUBLIC_KEY && process.env.ILOVEPDF_SECRET_KEY) {
    accounts.push({
      label: "primary",
      publicKey: process.env.ILOVEPDF_PUBLIC_KEY,
      secretKey: process.env.ILOVEPDF_SECRET_KEY,
    });
  }
  if (
    process.env.ILOVEPDF_PARTNER_PUBLIC_KEY &&
    process.env.ILOVEPDF_PARTNER_SECRET_KEY
  ) {
    accounts.push({
      label: "partner",
      publicKey: process.env.ILOVEPDF_PARTNER_PUBLIC_KEY,
      secretKey: process.env.ILOVEPDF_PARTNER_SECRET_KEY,
    });
  }

  let bestPath = null;
  let bestSize = Number.POSITIVE_INFINITY;
  let allLimits = accounts.length > 0;

  // ── Phase 1: standard iLovePDF extreme compress ───────────────────────────
  for (const acc of accounts) {
    try {
      console.log(`Trying iLovePDF compress (${acc.label})…`);
      const outPath = await compressViaIlove(
        inputPath,
        acc.label,
        acc.publicKey,
        acc.secretKey,
      );
      const s = fs.statSync(outPath).size;
      console.log(`iLovePDF compress (${acc.label}) => ${sizeMB(s)} MB`);
      if (s < bestSize) {
        bestSize = s;
        bestPath = outPath;
      }
      if (s <= MAX_BYTES) break;
      allLimits = false;
    } catch (err) {
      if (isIlovePdfLimitError(err)) {
        console.warn(`iLovePDF (${acc.label}) limit reached: ${err.message}`);
      } else {
        allLimits = false;
        console.warn(`iLovePDF compress (${acc.label}) failed: ${err.message}`);
      }
    }
  }

  // ── Phase 2: Ghostscript on iLovePDF output (or original if no iLovePDF) ──
  if (bestPath && bestSize > MAX_BYTES) {
    console.log(
      `Still ${sizeMB(bestSize)} MB — trying Ghostscript on iLovePDF output…`,
    );
    const gsOut = await compressViaGhostscript(bestPath, bestSize, { ultraBw });
    if (gsOut) {
      const gsSize = fs.statSync(gsOut).size;
      console.log(`Ghostscript => ${sizeMB(gsSize)} MB`);
      if (gsSize < bestSize) {
        bestSize = gsSize;
        bestPath = gsOut;
      }
    }
  } else if (!bestPath) {
    console.log("No iLovePDF result — trying Ghostscript on original…");
    const gsOut = await compressViaGhostscript(inputPath, inputSize, {
      ultraBw,
    });
    if (gsOut) {
      bestSize = fs.statSync(gsOut).size;
      bestPath = gsOut;
      console.log(`Ghostscript => ${sizeMB(bestSize)} MB`);
    }
  }

  // ── Phase 3: NUCLEAR – iLovePDF rasterisation (PDF → JPEG → PDF) ─────────
  //   Mimics PDFCandy "maximum" compression. Only runs when still above limit.
  if (bestSize > MAX_BYTES && accounts.length > 0) {
    console.log(
      `Still ${sizeMB(bestSize)} MB — engaging NUCLEAR mode (PDF→JPEG→PDF rasterisation)…`,
    );
    // Run nuclear on the BEST result so far (smallest), not the original.
    const nuclearSource = bestPath || inputPath;
    const nuclearSize = bestSize;

    for (const acc of accounts) {
      try {
        console.log(`Trying iLovePDF nuclear (${acc.label})…`);
        const outPath = await compressViaIloveNuclear(
          nuclearSource,
          acc.label,
          acc.publicKey,
          acc.secretKey,
        );
        const s = fs.statSync(outPath).size;
        console.log(`iLovePDF nuclear (${acc.label}) => ${sizeMB(s)} MB`);
        if (s < bestSize) {
          bestSize = s;
          bestPath = outPath;
        }
        if (s <= MAX_BYTES) break;
      } catch (err) {
        if (isIlovePdfLimitError(err)) {
          console.warn(`iLovePDF nuclear (${acc.label}) limit: ${err.message}`);
        } else {
          console.warn(
            `iLovePDF nuclear (${acc.label}) failed: ${err.message}`,
          );
        }
      }
    }

    // ── Phase 4: Ghostscript nuclear (grayscale + 25 DPI) on whatever we have
    if (bestSize > MAX_BYTES) {
      console.log(
        `Still ${sizeMB(bestSize)} MB — Ghostscript NUCLEAR (grayscale + 25 DPI)…`,
      );
      const gsNucOut = await compressViaGhostscript(
        bestPath || inputPath,
        bestSize,
        {
          nuclear: true,
        },
      );
      if (gsNucOut) {
        const s = fs.statSync(gsNucOut).size;
        console.log(`Ghostscript nuclear => ${sizeMB(s)} MB`);
        if (s < bestSize) {
          bestSize = s;
          bestPath = gsNucOut;
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  if (!bestPath || !fs.existsSync(bestPath)) {
    if (allLimits) {
      console.error(
        "Compression failed: iLovePDF limit reached on all accounts and no fallback result.",
      );
    } else {
      console.error("Compression failed: no valid compressed output produced.");
    }
    process.exit(1);
  }

  fs.copyFileSync(bestPath, outputPath);
  console.log(`Saved: ${outputPath}`);
  console.log(`Final size: ${sizeMB(bestSize)} MB`);

  if (bestSize > MAX_BYTES) {
    console.error(
      "FAILED: compressed file is still above 2 MB. Do not upload to Portnet.",
    );
    process.exit(3);
  }

  console.log("SUCCESS: file is <= 2 MB.");
}

main().catch((err) => {
  console.error(`Fatal: ${err?.message || err}`);
  process.exit(1);
});
