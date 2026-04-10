#!/usr/bin/env node
/**
 * Standalone test: compress a PDF via pdfRest "Compress PDF" API.
 *
 * Docs: https://pdfrest.com/apitools/compress-pdf/
 * Multipart example: https://pdfrest.com/learning/tutorials/how-to-compress-pdf-with-curl
 *
 * Env:
 *   PDFREST_API_KEY   – required (Api-Key header)
 *   PDFREST_REGION    – optional: "us" (default) or "eu" (GDPR endpoint)
 *
 * Usage:
 *   node scripts/compress-pdf-pdfrest.js <input.pdf> <output.pdf> [--level=high|medium|low] [--print-json]
 */

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Blob } = require("node:buffer");

const ENDPOINTS = {
  us: "https://api.pdfrest.com",
  eu: "https://eu-api.pdfrest.com",
};

function findHttpsUrls(obj, out = []) {
  if (obj == null) return out;
  if (typeof obj === "string" && /^https?:\/\//i.test(obj)) {
    out.push(obj);
    return out;
  }
  if (Array.isArray(obj)) {
    for (const x of obj) findHttpsUrls(x, out);
    return out;
  }
  if (typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (
        typeof v === "string" &&
        /^https?:\/\//i.test(v) &&
        /pdf|download|output|rest\.com/i.test(v)
      ) {
        out.push(v);
      } else {
        findHttpsUrls(v, out);
      }
    }
  }
  return out;
}

function pickDownloadUrl(data) {
  const direct =
    data?.downloadUrl ||
    data?.downloadURL ||
    data?.outputUrl ||
    data?.output_url ||
    data?.url ||
    data?.output?.url ||
    data?.output?.downloadUrl ||
    data?.files?.[0]?.url ||
    data?.files?.[0]?.downloadUrl;
  if (typeof direct === "string" && direct.startsWith("http")) return direct;

  const candidates = findHttpsUrls(data);
  return candidates[0] || null;
}

async function fetchResourceAsFile(apiBase, apiKey, id) {
  const url = `${apiBase.replace(/\/$/, "")}/resource/${encodeURIComponent(id)}?format=file`;
  const res = await fetch(url, {
    headers: {
      "Api-Key": apiKey,
      Accept: "application/pdf",
    },
  });
  if (!res.ok) throw new Error(`resource?format=file failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchResourceUrlJson(apiBase, apiKey, id) {
  const url = `${apiBase.replace(/\/$/, "")}/resource/${encodeURIComponent(id)}?format=url`;
  const res = await fetch(url, {
    headers: {
      "Api-Key": apiKey,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`resource?format=url failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function downloadResultPdf(apiBase, apiKey, data) {
  const dl = pickDownloadUrl(data);
  if (dl) {
    const res = await fetch(dl);
    if (!res.ok) throw new Error(`Download from URL failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  const id =
    data?.id ||
    data?.output?.id ||
    data?.files?.[0]?.id ||
    data?.resourceId ||
    null;

  if (id) {
    try {
      return await fetchResourceAsFile(apiBase, apiKey, id);
    } catch (e1) {
      const j = await fetchResourceUrlJson(apiBase, apiKey, id);
      const u = pickDownloadUrl(j);
      if (!u) throw e1;
      const res = await fetch(u);
      if (!res.ok) throw new Error(`Download after resource URL failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }
  }

  throw new Error(
    `Could not resolve output PDF from PDFRest response. Keys: ${Object.keys(data || {}).join(", ")}`,
  );
}

async function compressPdf(inputPath, outputPath, options) {
  const apiKey = String(process.env.PDFREST_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Set PDFREST_API_KEY in .env (pdfRest Api-Key header).");
  }

  const region = (process.env.PDFREST_REGION || "us").toLowerCase();
  const apiBase =
    options.apiBase ||
    (region === "eu" ? ENDPOINTS.eu : ENDPOINTS.us);

  const url = `${apiBase.replace(/\/$/, "")}/compressed-pdf`;
  const buf = fs.readFileSync(inputPath);
  const blob = new Blob([buf], { type: "application/pdf" });
  const form = new FormData();
  form.append("file", blob, path.basename(inputPath));
  form.append("compression_level", options.level || "high");
  const stem = path.parse(inputPath).name;
  form.append("output", outputPath ? path.parse(outputPath).name : `${stem}_pdfrest`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Api-Key": apiKey,
    },
    body: form,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`PDFRest non-JSON response (${res.status}): ${text.slice(0, 400)}`);
  }

  if (!res.ok) {
    throw new Error(`PDFRest error ${res.status}: ${JSON.stringify(data)}`);
  }

  if (options.printJson) {
    console.log(JSON.stringify(data, null, 2));
  }

  const pdfBuf = await downloadResultPdf(apiBase, apiKey, data);
  fs.writeFileSync(outputPath, pdfBuf);
  return pdfBuf.length;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const input = args[0];
  const output = args[1];
  const printJson = args.includes("--print-json");
  const levelArg = args.find((a) => a.startsWith("--level="));
  const level = levelArg ? levelArg.split("=")[1] : "high";
  const regionArg = args.find((a) => a.startsWith("--region="));
  const region = regionArg ? regionArg.split("=")[1].toLowerCase() : null;
  const apiBase =
    region === "eu"
      ? ENDPOINTS.eu
      : region === "us"
        ? ENDPOINTS.us
        : null;

  if (!input || !output) {
    console.error(
      'Usage: node scripts/compress-pdf-pdfrest.js <input.pdf> <output.pdf> [--level=high|medium|low] [--region=us|eu] [--print-json]',
    );
    process.exit(2);
  }

  const inputPath = path.resolve(input);
  const outputPath = path.resolve(output);
  if (!fs.existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`);
    process.exit(2);
  }

  const sizeBytes = await compressPdf(inputPath, outputPath, {
    level,
    printJson,
    apiBase: apiBase || undefined,
  });

  console.log(`Saved: ${outputPath}`);
  console.log(`Size: ${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
