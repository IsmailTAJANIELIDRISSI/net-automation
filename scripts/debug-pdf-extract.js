"use strict";

const fs = require("fs");
const path = require("path");

function resolvePdfJsBuild() {
  const libDir = path.dirname(require.resolve("pdf-parse/lib/pdf-parse.js"));
  const preferred = path.join(libDir, "pdf.js/v1.10.100/build/pdf.js");
  if (fs.existsSync(preferred)) return preferred;
  const pdfJsRoot = path.join(libDir, "pdf.js");
  const vers = fs.readdirSync(pdfJsRoot).filter((d) => /^v\d/.test(d));
  if (!vers.length) {
    throw new Error("pdf.js bundle not found next to pdf-parse");
  }
  vers.sort();
  return path.join(pdfJsRoot, vers[vers.length - 1], "build/pdf.js");
}

async function renderPageToText(page) {
  const renderOptions = {
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  };
  const textContent = await page.getTextContent(renderOptions);
  let lastY;
  let text = "";
  for (const item of textContent.items) {
    if (lastY === item.transform[5] || lastY == null) {
      text += item.str;
    } else {
      text += `\n${item.str}`;
    }
    lastY = item.transform[5];
  }
  return text;
}

async function debugPdf(pdfPath) {
  const PDFJS = require(resolvePdfJsBuild());
  PDFJS.disableWorker = true;

  const buf = fs.readFileSync(pdfPath);
  const doc = await PDFJS.getDocument(buf);
  const n = doc.numPages;

  console.log(`\n=== PDF: ${path.basename(pdfPath)} ===`);
  console.log(`Total pages: ${n}`);

  // First page
  const page1 = await doc.getPage(1);
  const text1 = await renderPageToText(page1);
  console.log(`\n--- PAGE 1 (first 2000 chars) ---`);
  console.log(text1.slice(0, 2000));

  // Last page
  const pageN = await doc.getPage(n);
  const textN = await renderPageToText(pageN);
  console.log(`\n--- PAGE ${n} (LAST - full text) ---`);
  console.log(textN);

  // Search for triplet pattern
  console.log(`\n--- TRIPLET SEARCH ---`);
  const patterns = [
    /(\d+)\s+(\d{1,3}(?:\s\d{3})*,\d{2})\s+(\d+)/g,
    /(\d+)\s+(\d+,\d{2})\s+(\d+)/g,
    /(\d+)\s+(\d+\.\d{2})\s+(\d+)/g,
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(textN)) !== null) {
      console.log(`Match: [${m[1]}] [${m[2]}] [${m[3]}]`);
    }
  }

  await doc.destroy();
}

const pdfPath =
  process.argv[2] ||
  path.join(
    __dirname,
    "..",
    "Acheminements",
    "test ach",
    "35eme LTA",
    "Manifeste 157-54440153.pdf",
  );

debugPdf(pdfPath).catch(console.error);
