"use strict";

/**
 * Shared annex PDF helpers:
 *  - compressPdfForAnnex: compress one PDF to ≤ 2 MB via iLovePDF ×3 → Adobe, or throw.
 *  - prepareManifestPartsForAnnex: split an oversized manifest into ≤ 2 MB page-range
 *    parts (compressing any part that's still too big). The legal replacement for the
 *    old first/last-page truncation, which Moroccan customs flags as illegal.
 * Used by PortnetDsCombine, badrDumNormalPartiel and scripts/compress-pdf-chain.js.
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

function unlinkSafe(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

/**
 * Compress a single PDF to ≤ 2 MB via the API chain (iLovePDF ×3 → Adobe).
 * Throws if it cannot bring the file under 2 MB. There is NO page-dropping
 * fallback: Moroccan customs flags first/last-page-only manifests as illegal,
 * so an oversized manifest must be SPLIT (see prepareManifestPartsForAnnex)
 * rather than truncated.
 *
 * @param {string} inputPath
 * @param {{ info?: Function, warn?: Function }} log
 * @returns {Promise<{ uploadPath: string, mode: 'original' | 'compressed' }>}
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

  for (const acc of iloveAccounts) {
    try {
      L.info(`PDF compress: trying ${acc.label}…`);
      const tmp = await compressViaIlove(resolved, acc.label, acc.pub, acc.sec);
      const sz = fs.statSync(tmp).size;
      L.info(`PDF compress (${acc.label}): ${mb(sz)} MB`);
      if (sz <= MAX_BYTES) {
        L.info(`PDF compress: ✓ ${mb(sz)} MB ≤ 2 MB — using compressed file`);
        return { uploadPath: tmp, mode: "compressed" };
      }
      unlinkSafe(tmp);
      L.warn(
        `PDF compress (${acc.label}): result ${mb(sz)} MB > 2 MB — trying next provider`,
      );
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
      if (sz <= MAX_BYTES) {
        return { uploadPath: tmp, mode: "compressed" };
      }
      unlinkSafe(tmp);
      L.warn(`PDF compress (Adobe): result ${mb(sz)} MB > 2 MB`);
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

  throw new Error(
    `Annex PDF "${path.basename(resolved)}" cannot be reduced under 2 MB via compression ` +
      `(source ${mb(inSize)} MB). Split it into smaller parts instead.`,
  );
}

// ── Manifest splitting (legal alternative to page-dropping) ──────────────────

/** Build a temp PDF from pages [startIdx, endExclusive) of srcDoc. */
async function _buildPartPdf(srcDoc, startIdx, endExclusive, baseName, partNum) {
  const out = await PDFDocument.create();
  const indexes = [];
  for (let i = startIdx; i < endExclusive; i++) indexes.push(i);
  const pages = await out.copyPages(srcDoc, indexes);
  for (const p of pages) out.addPage(p);
  const outBytes = await out.save({
    useObjectStreams: true,
    addDefaultPage: false,
  });
  const outPath = path.join(
    os.tmpdir(),
    `manifest_part${partNum}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${baseName}.pdf`,
  );
  fs.writeFileSync(outPath, outBytes);
  return outPath;
}

/**
 * Split a PDF into two page-halves (e.g. 101 pages → 51 + 50). If a half is
 * still > 2 MB, compress it; if compression still can't reach 2 MB, recurse
 * (halve that half again) so a very large manifest never blocks. Returns temp
 * file paths of the resulting parts, each ≤ 2 MB, in page order.
 *
 * @returns {Promise<string[]>}
 */
async function _splitInHalves(inputPath, log = {}, depth = 0) {
  const L = {
    info: typeof log.info === "function" ? log.info.bind(log) : console.log,
    warn: typeof log.warn === "function" ? log.warn.bind(log) : console.warn,
  };

  const resolved = path.resolve(inputPath);
  const src = await PDFDocument.load(fs.readFileSync(resolved));
  const n = src.getPageCount();
  const baseName = path.parse(resolved).name;

  if (n <= 1) {
    // Can't halve a single page — compress it (throws if impossible).
    L.warn(
      `Split: "${path.basename(resolved)}" is a single page > 2 MB — compressing…`,
    );
    const { uploadPath } = await compressPdfForAnnex(resolved, log);
    return [uploadPath];
  }

  const mid = Math.ceil(n / 2);
  L.info(
    `Split: ${n} pages → 2 halves (${mid} + ${n - mid})${depth ? ` [depth ${depth}]` : ""}…`,
  );
  const halves = [
    await _buildPartPdf(src, 0, mid, baseName, `${depth}a`),
    await _buildPartPdf(src, mid, n, baseName, `${depth}b`),
  ];

  const out = [];
  for (const half of halves) {
    const size = fs.statSync(half).size;
    if (size <= MAX_BYTES) {
      L.info(`Split: half ${mb(size)} MB ≤ 2 MB ✓`);
      out.push(half);
      continue;
    }
    // Half still too big → compress it (the user's "compress the convenable part").
    L.warn(`Split: half ${mb(size)} MB > 2 MB — compressing this half…`);
    try {
      const { uploadPath } = await compressPdfForAnnex(half, log);
      if (uploadPath !== half) unlinkSafe(half);
      out.push(uploadPath);
    } catch (e) {
      // Compression couldn't reach 2 MB → halve this half again (safety net).
      L.warn(
        `Split: half still > 2 MB after compression — halving it again. (${e.message})`,
      );
      const sub = await _splitInHalves(half, log, depth + 1);
      unlinkSafe(half);
      out.push(...sub);
    }
  }
  return out;
}

/**
 * Re-save an entire PDF via pdf-lib, stripping incremental-update / unused-object
 * bloat. This is lossless (all pages/content kept) and free (no API), and on its
 * own brings most oversized "digital" manifests well under 2 MB. Returns a temp path.
 */
async function _resaveWholePdf(inputPath) {
  const src = await PDFDocument.load(fs.readFileSync(inputPath));
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, src.getPageIndices());
  for (const p of pages) out.addPage(p);
  const bytes = await out.save({
    useObjectStreams: true,
    addDefaultPage: false,
  });
  const outPath = path.join(
    os.tmpdir(),
    `manifest_resaved_${Date.now()}_${path.parse(inputPath).name}.pdf`,
  );
  fs.writeFileSync(outPath, bytes);
  return outPath;
}

/**
 * Prepare a manifest for the Portnet annexe as one or more upload-ready parts,
 * each ≤ 2 MB. Order of operations (compress first, split only if needed):
 *   1. ≤ 2 MB → upload the original whole.
 *   2. Re-save (strip bloat, lossless, free). ≤ 2 MB → upload the whole re-saved.
 *   3. Still too big → split the RE-SAVED file into the MINIMAL number of
 *      ≤ 2 MB page-range parts (using realistic page sizes, so 2 parts not 9).
 *      Any part that is still > 2 MB (e.g. a heavy single page) is compressed
 *      via the API chain (throws if even that fails — no illegal page-dropping).
 *
 * @returns {Promise<Array<{ uploadPath: string, name: string, mode: string }>>}
 */
async function prepareManifestPartsForAnnex(inputPath, log = {}) {
  const L = {
    info: typeof log.info === "function" ? log.info.bind(log) : console.log,
    warn: typeof log.warn === "function" ? log.warn.bind(log) : console.warn,
  };

  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) throw new Error(`Manifest not found: ${resolved}`);
  if (!isLikelyValidPdf(resolved))
    throw new Error(`Invalid manifest PDF: ${resolved}`);

  const baseName = path.parse(resolved).name;
  const inSize = fs.statSync(resolved).size;

  // 1. Already small enough.
  if (inSize <= MAX_BYTES) {
    L.info(
      `Manifest "${path.basename(resolved)}" is ${mb(inSize)} MB ≤ 2 MB — uploading whole.`,
    );
    return [
      { uploadPath: resolved, name: path.basename(resolved), mode: "original" },
    ];
  }

  // 2. Compression-first: re-save the whole PDF (strips bloat). This alone
  //    brings most oversized digital manifests under 2 MB → single upload.
  L.info(
    `Manifest "${path.basename(resolved)}" is ${mb(inSize)} MB > 2 MB — re-saving to strip bloat…`,
  );
  const resaved = await _resaveWholePdf(resolved);
  const resavedSize = fs.statSync(resaved).size;
  L.info(`Manifest re-saved: ${mb(inSize)} → ${mb(resavedSize)} MB.`);

  if (resavedSize <= MAX_BYTES) {
    L.info("Manifest fits ≤ 2 MB after re-save — uploading whole (no split).");
    return [{ uploadPath: resaved, name: `${baseName}.pdf`, mode: "resaved" }];
  }

  // 3. Still too big → split into 2 page-halves; compress an oversized half
  //    (recurse only if a compressed half is somehow still > 2 MB).
  L.info(`Manifest still ${mb(resavedSize)} MB > 2 MB — splitting in half…`);
  const partPaths = await _splitInHalves(resaved, log);
  unlinkSafe(resaved); // halves are independent temp files
  const total = partPaths.length;
  const result = partPaths.map((p, i) => ({
    uploadPath: p,
    name: total > 1 ? `${baseName}-part-${i + 1}.pdf` : `${baseName}.pdf`,
    mode: "split",
  }));
  L.info(`Manifest prepared as ${total} part(s).`);
  return result;
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
  prepareManifestPartsForAnnex,
  compressMawbGhostscript,
  MAX_BYTES,
  isLikelyValidPdf,
};
