#!/usr/bin/env node
"use strict";

require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { PDFDocument } = require("pdf-lib");
const {
  ServicePrincipalCredentials,
  PDFServices,
  MimeType,
  CompressPDFJob,
  CompressPDFResult,
  CompressPDFParams,
  CompressionLevel,
} = require("@adobe/pdfservices-node-sdk");

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

function isAdobeLimitError(err) {
  const text = String(err?.message || "").toLowerCase();
  return (
    text.includes("quota") ||
    text.includes("limit") ||
    text.includes("429") ||
    text.includes("403")
  );
}

function resolveGhostscriptExecutables() {
  const envPath = String(process.env.PORTNET_GS_PATH || "").trim();
  const candidates = [];
  if (envPath) candidates.push(envPath);

  if (process.platform === "win32") {
    const pf64 =
      process.env.ProgramW6432 || process.env.ProgramFiles || "C:\\Program Files";
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
      path.join(pf32, "gs", "gs10.05.1", "bin", "gswin32c.exe"),
    ];
    for (const p of known) if (fs.existsSync(p)) candidates.push(p);
  }

  candidates.push("gswin64c", "gswin32c", "gs");
  return [...new Set(candidates)];
}

async function compressViaAdobe(filePath, clientId, clientSecret) {
  const credentials = new ServicePrincipalCredentials({
    clientId,
    clientSecret,
  });
  const pdfServices = new PDFServices({ credentials });

  const readStream = fs.createReadStream(filePath);
  try {
    const inputAsset = await pdfServices.upload({
      readStream,
      mimeType: MimeType.PDF,
    });

    const params = new CompressPDFParams({
      compressionLevel: CompressionLevel.HIGH,
    });
    const job = new CompressPDFJob({ inputAsset, params });

    const pollingURL = await pdfServices.submit({ job });
    const pdfServicesResponse = await pdfServices.getJobResult({
      pollingURL,
      resultType: CompressPDFResult,
    });

    const resultAsset = pdfServicesResponse.result.asset;
    const streamAsset = await pdfServices.getContent({ asset: resultAsset });

    const outPath = path.join(
      os.tmpdir(),
      `pdf_adobe_${Date.now()}_${path.basename(filePath)}`,
    );
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outPath);
      streamAsset.readStream.on("error", reject);
      output.on("error", reject);
      output.on("finish", resolve);
      streamAsset.readStream.pipe(output);
    });

    if (!isLikelyValidPdf(outPath)) {
      throw new Error("Adobe returned invalid PDF");
    }
    return outPath;
  } finally {
    readStream.destroy();
  }
}

async function compressViaGhostscript(filePath, sizeBytes) {
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
      `pdf_gs_${Date.now()}_${path.basename(filePath)}`,
    );
    try {
      await execFileAsync(
        exe,
        [
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
        ],
        { timeout: timeoutMs },
      );

      if (!fs.existsSync(outPath) || !isLikelyValidPdf(outPath)) continue;
      const s = fs.statSync(outPath).size;
      if (s < bestSize) {
        bestSize = s;
        bestPath = outPath;
      }
      if (s <= MAX_BYTES) return outPath;
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

async function createFirstLastPagePdf(sourcePath, outputPath) {
  const bytes = fs.readFileSync(sourcePath);
  const srcDoc = await PDFDocument.load(bytes);
  const pageCount = srcDoc.getPageCount();

  if (pageCount < 1) {
    throw new Error("Source PDF has no pages");
  }

  const outDoc = await PDFDocument.create();
  const firstIndex = 0;
  const lastIndex = pageCount - 1;
  const pageIndexes = pageCount === 1 ? [firstIndex] : [firstIndex, lastIndex];

  const pages = await outDoc.copyPages(srcDoc, pageIndexes);
  for (const p of pages) outDoc.addPage(p);

  const outBytes = await outDoc.save({
    useObjectStreams: true,
    addDefaultPage: false,
  });
  fs.writeFileSync(outputPath, outBytes);
}

async function main() {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) {
    console.error(
      'Usage: node scripts/compress-pdf-adobe.js "input.pdf" "output.pdf"',
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
  console.log(`Target: <= 2.00 MB`);

  let bestPath = inputPath;
  let bestSize = inputSize;

  if (
    bestSize > MAX_BYTES &&
    (process.env.PDF_SERVICES_CLIENT_ID || process.env.ADOBE_CLIENT_ID) &&
    (process.env.PDF_SERVICES_CLIENT_SECRET || process.env.ADOBE_CLIENT_SECRET)
  ) {
    try {
      console.log("Trying Adobe PDF Services compress...");
      const adobeClientId =
        process.env.PDF_SERVICES_CLIENT_ID || process.env.ADOBE_CLIENT_ID;
      const adobeClientSecret =
        process.env.PDF_SERVICES_CLIENT_SECRET || process.env.ADOBE_CLIENT_SECRET;
      const out = await compressViaAdobe(
        bestPath,
        adobeClientId,
        adobeClientSecret,
      );
      const s = fs.statSync(out).size;
      console.log(`Adobe compress => ${sizeMB(s)} MB`);
      if (s < bestSize) {
        bestPath = out;
        bestSize = s;
      }
    } catch (err) {
      const prefix = isAdobeLimitError(err)
        ? "Adobe limit reached"
        : "Adobe compress failed";
      console.warn(`${prefix}: ${err.message}`);
    }
  } else if (bestSize > MAX_BYTES) {
    console.log("Adobe credentials not configured; cannot run Adobe compression.");
  }

  if (bestSize > MAX_BYTES) {
    console.log(`Still ${sizeMB(bestSize)} MB — trying Ghostscript fallback...`);
    const gsOut = await compressViaGhostscript(bestPath, bestSize);
    if (gsOut && fs.existsSync(gsOut)) {
      const s = fs.statSync(gsOut).size;
      console.log(`Ghostscript => ${sizeMB(s)} MB`);
      if (s < bestSize) {
        bestPath = gsOut;
        bestSize = s;
      }
    }
  }

  fs.copyFileSync(bestPath, outputPath);
  console.log(`Saved: ${outputPath}`);
  console.log(`Final size: ${sizeMB(bestSize)} MB`);

  if (bestSize > MAX_BYTES) {
    const originalNameTarget = path.join(
      path.dirname(outputPath),
      path.basename(inputPath),
    );
    const fallbackPath =
      path.resolve(originalNameTarget) === path.resolve(inputPath)
        ? path.join(
            path.dirname(outputPath),
            `${path.parse(inputPath).name}_first_last.pdf`,
          )
        : originalNameTarget;

    console.warn(
      "Compressed file is still above 2 MB. Creating fallback with first + last page...",
    );
    await createFirstLastPagePdf(bestPath, fallbackPath);
    const fallbackSize = fs.statSync(fallbackPath).size;
    console.log(`Saved fallback: ${fallbackPath}`);
    console.log(`Fallback size: ${sizeMB(fallbackSize)} MB`);

    if (fallbackSize > MAX_BYTES) {
      console.error(
        "FAILED: even first+last-page fallback is still above 2 MB.",
      );
      process.exit(3);
    }

    console.log("SUCCESS: first+last-page fallback is <= 2 MB.");
    process.exit(0);
  }

  console.log("SUCCESS: file is <= 2 MB.");
}

main().catch((err) => {
  console.error(`Fatal: ${err?.message || err}`);
  process.exit(1);
});
