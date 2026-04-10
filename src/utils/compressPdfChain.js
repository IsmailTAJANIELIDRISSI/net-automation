"use strict";

/**
 * Shared annex compression: iLovePDF (primary → partner → partner2) → Adobe → first+last fallback.
 * Used by PortnetDsCombine and scripts/compress-pdf-chain.js.
 *
 * @param {string} inputPath - absolute path to source PDF
 * @param {{ info?: Function, warn?: Function }} log - logger (e.g. Portnet logger)
 * @returns {Promise<{ uploadPath: string, mode: 'original' | 'compressed' | 'first_last' }>}
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, execSync } = require("child_process");
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

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — Portnet hard upload limit
const SAFE_BYTES = 1900 * 1024; // 1900 KB — acceptance threshold; above this → first+last fallback

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function isLikelyValidPdf(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 32) return false;
    const fd = fs.openSync(filePath, "r");
    try {
      const head = Buffer.alloc(8);
      fs.readSync(fd, head, 0, 8, 0);
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

function isIloveQuotaError(err) {
  const code =
    err?.response?.status ||
    err?.statusCode ||
    err?.status ||
    (typeof err?.code === "number" ? err.code : null);
  if (code === 401 || code === 402 || code === 429) return true;
  const t = String(err?.message || err || "").toLowerCase();
  return (
    t.includes("limit") ||
    t.includes("quota") ||
    t.includes("remaining") ||
    t.includes("insufficient") ||
    t.includes("unauthorized")
  );
}

function isAdobeLimitError(err) {
  const t = String(err?.message || err || "").toLowerCase();
  return (
    t.includes("quota") ||
    t.includes("limit") ||
    t.includes("429") ||
    t.includes("403") ||
    t.includes("402") ||
    t.includes("401")
  );
}

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
    throw new Error("iLovePDF empty download");
  }
  const outPath = path.join(
    os.tmpdir(),
    `portnet_annex_ilove_${label}_${Date.now()}_${path.basename(filePath)}`,
  );
  fs.writeFileSync(outPath, data);
  if (!isLikelyValidPdf(outPath)) {
    try {
      fs.unlinkSync(outPath);
    } catch {}
    throw new Error("iLovePDF invalid PDF");
  }
  return outPath;
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
      `portnet_annex_adobe_${Date.now()}_${path.basename(filePath)}`,
    );
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outPath);
      streamAsset.readStream.on("error", reject);
      output.on("error", reject);
      output.on("finish", resolve);
      streamAsset.readStream.pipe(output);
    });

    if (!isLikelyValidPdf(outPath)) {
      try {
        fs.unlinkSync(outPath);
      } catch {}
      throw new Error("Adobe returned invalid PDF");
    }
    return outPath;
  } finally {
    readStream.destroy();
  }
}

async function writeFirstLastPagesToPath(inputPath, outputPath) {
  const bytes = fs.readFileSync(inputPath);
  const src = await PDFDocument.load(bytes);
  const n = src.getPageCount();
  if (n < 1) throw new Error("PDF has no pages");
  const out = await PDFDocument.create();
  const indexes = n === 1 ? [0] : [0, n - 1];
  const pages = await out.copyPages(src, indexes);
  for (const p of pages) out.addPage(p);
  const outBytes = await out.save({
    useObjectStreams: true,
    addDefaultPage: false,
  });
  fs.writeFileSync(outputPath, outBytes);
}

/**
 * @param {string} inputPath
 * @param {{ info?: Function, warn?: Function }} log
 */
async function compressPdfForAnnex(inputPath, log = {}) {
  const L = {
    info: typeof log.info === "function" ? log.info.bind(log) : console.log,
    warn: typeof log.warn === "function" ? log.warn.bind(log) : console.warn,
  };

  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`PDF not found: ${resolved}`);
  }
  if (!isLikelyValidPdf(resolved)) {
    throw new Error(`Invalid PDF: ${resolved}`);
  }

  const inSize = fs.statSync(resolved).size;
  if (inSize <= MAX_BYTES) {
    L.info(
      `PDF compress: "${path.basename(resolved)}" is ${mb(inSize)} MB — already ≤ 2 MB.`,
    );
    return { uploadPath: resolved, mode: "original" };
  }

  L.info(
    `PDF compress: "${path.basename(resolved)}" is ${mb(inSize)} MB — compressing (chain)…`,
  );

  const iloveAccounts = [
    {
      label: "ilove-primary",
      pub: String(process.env.ILOVEPDF_PUBLIC_KEY || "").trim(),
      sec: String(process.env.ILOVEPDF_SECRET_KEY || "").trim(),
    },
    {
      label: "ilove-partner",
      pub: String(process.env.ILOVEPDF_PARTNER_PUBLIC_KEY || "").trim(),
      sec: String(process.env.ILOVEPDF_PARTNER_SECRET_KEY || "").trim(),
    },
    {
      label: "ilove-partner2",
      pub: String(process.env.ILOVEPDF_PARTNER2_PUBLIC_KEY || "").trim(),
      sec: String(process.env.ILOVEPDF_PARTNER2_SECRET_KEY || "").trim(),
    },
  ].filter((a) => a.pub && a.sec);

  const adobeClientId = String(
    process.env.PDF_SERVICES_CLIENT_ID || process.env.ADOBE_CLIENT_ID || "",
  ).trim();
  const adobeClientSecret = String(
    process.env.PDF_SERVICES_CLIENT_SECRET ||
      process.env.ADOBE_CLIENT_SECRET ||
      "",
  ).trim();

  function unlinkSafe(p) {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  }

  for (const acc of iloveAccounts) {
    try {
      L.info(`PDF compress: trying ${acc.label}…`);
      const tmp = await compressViaIlove(resolved, acc.label, acc.pub, acc.sec);
      const sz = fs.statSync(tmp).size;
      L.info(`PDF compress (${acc.label}): ${mb(sz)} MB`);
      if (sz <= SAFE_BYTES) {
        L.info(
          `PDF compress: ✓ ${mb(sz)} MB ≤ 1900 KB — using compressed file`,
        );
        return { uploadPath: tmp, mode: "compressed" };
      }
      unlinkSafe(tmp);
      L.warn(
        `PDF compress (${acc.label}): result ${mb(sz)} MB > 1900 KB — building first+last page PDF only (no more API calls).`,
      );
      const flPath = path.join(
        os.tmpdir(),
        `portnet_annex_firstlast_${Date.now()}_${path.basename(resolved)}`,
      );
      await writeFirstLastPagesToPath(resolved, flPath);
      const fz = fs.statSync(flPath).size;
      L.info(`PDF compress (first+last): ${mb(fz)} MB`);
      if (fz > MAX_BYTES) {
        unlinkSafe(flPath);
        throw new Error(
          `First+last page fallback still exceeds 2 MB (${mb(fz)} MB).`,
        );
      }
      return { uploadPath: flPath, mode: "first_last" };
    } catch (err) {
      if (isIloveQuotaError(err)) {
        L.warn(
          `PDF compress (${acc.label}) quota/limit — ${err?.message || err}`,
        );
        continue;
      }
      L.warn(`PDF compress (${acc.label}) failed: ${err?.message || err}`);
      continue;
    }
  }

  if (adobeClientId && adobeClientSecret) {
    try {
      L.info("PDF compress: trying Adobe PDF Services…");
      const tmp = await compressViaAdobe(
        resolved,
        adobeClientId,
        adobeClientSecret,
      );
      const sz = fs.statSync(tmp).size;
      L.info(`PDF compress (Adobe): ${mb(sz)} MB`);
      if (sz <= SAFE_BYTES) {
        return { uploadPath: tmp, mode: "compressed" };
      }
      unlinkSafe(tmp);
      L.warn(
        `PDF compress (Adobe): result ${mb(sz)} MB > 1900 KB — building first+last page PDF only.`,
      );
      const flPath = path.join(
        os.tmpdir(),
        `portnet_annex_firstlast_${Date.now()}_${path.basename(resolved)}`,
      );
      await writeFirstLastPagesToPath(resolved, flPath);
      const fz = fs.statSync(flPath).size;
      if (fz > MAX_BYTES) {
        unlinkSafe(flPath);
        throw new Error(
          `First+last page fallback still exceeds 2 MB (${mb(fz)} MB).`,
        );
      }
      return { uploadPath: flPath, mode: "first_last" };
    } catch (err) {
      if (isAdobeLimitError(err)) {
        L.warn(`PDF compress (Adobe) quota/limit: ${err?.message || err}`);
      } else {
        L.warn(`PDF compress (Adobe) failed: ${err?.message || err}`);
      }
    }
  } else {
    L.warn(
      "PDF compress: Adobe credentials not set (PDF_SERVICES_CLIENT_ID / SECRET).",
    );
  }

  L.warn(
    "PDF compress: all API steps failed — building first+last page fallback from original PDF.",
  );
  const flPath = path.join(
    os.tmpdir(),
    `portnet_annex_firstlast_${Date.now()}_${path.basename(resolved)}`,
  );
  await writeFirstLastPagesToPath(resolved, flPath);
  const fz = fs.statSync(flPath).size;
  L.info(`PDF compress (first+last fallback): ${mb(fz)} MB`);
  if (fz > MAX_BYTES) {
    unlinkSafe(flPath);
    throw new Error(
      `Annex PDF cannot be reduced under 2 MB (first+last is ${mb(fz)} MB).`,
    );
  }
  return { uploadPath: flPath, mode: "first_last" };
}

// ── MAWB Ghostscript compression (no API keys) ──────────────────────────────

/**
 * Find the Ghostscript binary on this system.
 * Checks known Windows install paths (any gs version under Program Files\gs) then PATH.
 * @returns {string|null}
 */
function findGsBinary() {
  // Scan all installed GS versions under Program Files\gs (Windows), newest first
  const gsBase = "C:\\Program Files\\gs";
  if (fs.existsSync(gsBase)) {
    try {
      const versions = fs.readdirSync(gsBase).sort().reverse();
      for (const v of versions) {
        const p = path.join(gsBase, v, "bin", "gswin64c.exe");
        if (fs.existsSync(p)) return p;
      }
    } catch {}
  }
  // Try PATH
  for (const cmd of ["gswin64c", "gswin32c", "gs"]) {
    try {
      execSync(`"${cmd}" --version`, { stdio: "ignore", timeout: 3000 });
      return cmd;
    } catch {}
  }
  return null;
}

const MAWB_COMPRESS_THRESHOLD = 2 * 1024 * 1024; // 2 MB

/**
 * Compress a MAWB PDF using local Ghostscript (no API keys required).
 * Only compresses if the file exceeds 2 MB.
 * Tries /printer → /ebook → /screen progressively until ≤ 2 MB is reached.
 * Validates the output with isLikelyValidPdf before accepting it.
 * Returns the smallest valid result even if the 2 MB target is not met.
 *
 * @param {string} filePath - absolute path to MAWB PDF
 * @param {{ info?: Function, warn?: Function }} log
 * @returns {Promise<{ uploadPath: string, mode: 'original' | 'compressed' }>}
 */
async function compressMawbGhostscript(filePath, log = {}) {
  const L = {
    info: typeof log.info === "function" ? log.info.bind(log) : console.log,
    warn: typeof log.warn === "function" ? log.warn.bind(log) : console.warn,
  };

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved))
    throw new Error(`MAWB PDF not found: ${resolved}`);
  if (!isLikelyValidPdf(resolved))
    throw new Error(`MAWB PDF invalid or corrupted: ${resolved}`);

  const inSize = fs.statSync(resolved).size;
  if (inSize <= MAWB_COMPRESS_THRESHOLD) {
    L.info(
      `MAWB compress: "${path.basename(resolved)}" is ${mb(inSize)} MB — already ≤ 2 MB, no compression needed.`,
    );
    return { uploadPath: resolved, mode: "original" };
  }

  const gsBin = findGsBinary();
  if (!gsBin) {
    L.warn(
      `MAWB compress: Ghostscript not found — using original file (${mb(inSize)} MB). ` +
        `Install Ghostscript from https://www.ghostscript.com/ to enable MAWB compression.`,
    );
    return { uploadPath: resolved, mode: "original" };
  }

  L.info(
    `MAWB compress: "${path.basename(resolved)}" is ${mb(inSize)} MB — compressing with Ghostscript…`,
  );

  const levels = [
    // Level 1: standard preset — light touch for PDFs not already at low DPI
    {
      label: "printer (300 dpi)",
      extraArgs: ["-dPDFSETTINGS=/printer"],
    },
    // Level 2: ebook preset
    {
      label: "ebook (150 dpi)",
      extraArgs: ["-dPDFSETTINGS=/ebook"],
    },
    // Level 3: screen preset (72 dpi)
    {
      label: "screen (72 dpi)",
      extraArgs: ["-dPDFSETTINGS=/screen"],
    },
    // Level 4: force-downsample to 96 dpi (handles pre-compressed JPEG images
    //          that /screen alone cannot reduce because GS passes them through)
    {
      label: "screen + force downsample 96 dpi",
      extraArgs: [
        "-dPDFSETTINGS=/screen",
        "-dDownsampleColorImages=true",
        "-dColorImageDownsampleType=/Bicubic",
        "-dColorImageResolution=96",
        "-dDownsampleGrayImages=true",
        "-dGrayImageDownsampleType=/Bicubic",
        "-dGrayImageResolution=96",
        "-dDownsampleMonoImages=true",
        "-dMonoImageResolution=150",
      ],
    },
    // Level 5: most aggressive — 72 dpi with lower JPEG quality
    {
      label: "screen + force downsample 72 dpi",
      extraArgs: [
        "-dPDFSETTINGS=/screen",
        "-dDownsampleColorImages=true",
        "-dColorImageDownsampleType=/Bicubic",
        "-dColorImageResolution=72",
        "-dDownsampleGrayImages=true",
        "-dGrayImageDownsampleType=/Bicubic",
        "-dGrayImageResolution=72",
        "-dDownsampleMonoImages=true",
        "-dMonoImageResolution=150",
        "-dJPEGQ=60",
      ],
    },
  ];

  let bestPath = null;
  let bestSize = inSize;

  for (const { extraArgs, label } of levels) {
    const tmpPath = path.join(
      os.tmpdir(),
      `mawb_gs_${Date.now()}_${path.basename(resolved)}`,
    );
    try {
      await new Promise((resolve, reject) => {
        execFile(
          gsBin,
          [
            "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.4",
            ...extraArgs,
            "-dNOPAUSE",
            "-dQUIET",
            "-dBATCH",
            `-sOutputFile=${tmpPath}`,
            resolved,
          ],
          { timeout: 60000 },
          (err) => (err ? reject(err) : resolve()),
        );
      });

      if (!fs.existsSync(tmpPath)) continue;

      const outSize = fs.statSync(tmpPath).size;
      const reduction = (((inSize - outSize) / inSize) * 100).toFixed(1);
      L.info(
        `MAWB compress [${label}]: ${mb(outSize)} MB (${reduction}% reduction)`,
      );

      if (!isLikelyValidPdf(tmpPath)) {
        L.warn(
          `MAWB compress [${label}]: output failed PDF validation — skipping`,
        );
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
        continue;
      }

      if (outSize <= MAWB_COMPRESS_THRESHOLD) {
        // Target reached — clean up previous best candidate
        if (bestPath) {
          try {
            fs.unlinkSync(bestPath);
          } catch {}
        }
        L.info(`MAWB compress: ✓ target ≤ 2 MB reached with [${label}]`);
        return { uploadPath: tmpPath, mode: "compressed" };
      }

      // Not small enough yet — keep as best candidate, try next level
      if (bestPath) {
        try {
          fs.unlinkSync(bestPath);
        } catch {}
      }
      bestPath = tmpPath;
      bestSize = outSize;
    } catch (err) {
      L.warn(`MAWB compress [${label}]: Ghostscript error — ${err.message}`);
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {}
      }
    }
  }

  // All 3 levels tried — use best result if smaller than original and valid
  if (bestPath && bestSize < inSize && isLikelyValidPdf(bestPath)) {
    L.warn(
      `MAWB compress: could not reach ≤ 2 MB — best result is ${mb(bestSize)} MB. Using it.`,
    );
    return { uploadPath: bestPath, mode: "compressed" };
  }

  if (bestPath) {
    try {
      fs.unlinkSync(bestPath);
    } catch {}
  }
  L.warn(
    `MAWB compress: Ghostscript could not reduce size — using original (${mb(inSize)} MB).`,
  );
  return { uploadPath: resolved, mode: "original" };
}

module.exports = {
  compressPdfForAnnex,
  compressMawbGhostscript,
  MAX_BYTES,
  isLikelyValidPdf,
};
