# Manifest PDF — expected layout and extraction rules

This document describes **what the app expects** in a **Manifeste** (or Temu-style) PDF so `src/utils/manifestPdfExtract.js` can fill Portnet fields (référence LTA, nb. contenant, poids, devise, valeur totale). Use it for onboarding, QA, or as a **prompt** for tools or assistants that help parse or validate manifests.

---

## 1. Pages we read

| Source | Why |
|--------|-----|
| **Page 1** | Header block + start of table (MAWB, Pcs, kg, Currency, table currency column). |
| **Last page** | Footer row with **three totals**; the **2nd** number is **Valeur totale**. |

Manifests are often **200+ pages**. We **do not** concatenate the whole PDF text for extraction; we only extract text from **page 1** and **page N** (same PDF.js pipeline as `pdf-parse`).

If that fails, we fall back to slicing text from a full `pdf-parse` run (less reliable on huge files).

---

## 2. Fields to extract (UI / automation)

| Field | French / UI label | Where in PDF | Example | Notes |
|-------|-------------------|--------------|---------|--------|
| **refNumber** | Réf. LTA / MAWB | **Page 1** — line `MAWB <ref>` or first `\d{1,4}-\d{6,}` | `157-54440153` | Normalized (leading zeros on left segment trimmed). |
| **nombreContenant** | Nb. contenant | **Page 1** — before `Pcs` | `136` | Integer. |
| **poidTotal** | Poids total (kg) | **Page 1** — before `kg` | `2530` | Digits; may use `,` or `.` in source; stored as string for forms. |
| **currency** | Devise | **Page 1** — `Currency:<code>` **or** first table currency (`MAD`, `USD`, …) | `MAD` | Header wins; else first `MAD|USD|EUR|…` in page-1 text. |
| **totalValue** | Valeur totale | **Last page** — **2nd of three** footer numbers | `243596,74` → `243596.74` for UI | French decimal comma; see §3. |

**Not** taken from PDF today: scellés, séquence BADR, lieu de chargement (unless added later).

---

## 3. Page 1 — header block (typical Temu layout)

Expected structure (text order may vary slightly; regexes allow tight spacing):

```text
MAWB 157-54440153
136Pcs 2530kg Currency:MAD
2781 Positions
```

- **LTA reference:** after `MAWB` or any `\b\d{1,4}-\d{6,}\b`.
- **Nb. contenant:** digits immediately before `Pcs` (case-insensitive).
- **Poids total:** digits before `kg`.
- **Currency:** after `Currency:` (3 letters), or from the **left column** of the table (`MAD` repeated per row) if the header line is missing.

---

## 4. Last page — footer totals (Valeur totale)

At the **bottom of the main table**, a row with **exactly three** numeric values (same line or broken across lines):

```text
2781 243596,74 2530
```

| Position | Meaning (typical) | Use in app |
|----------|-------------------|------------|
| 1st | Positions / lines count | Not stored |
| **2nd** | **Valeur totale** (French format: `243596,74` or `243 596,74`) | **Extract this** → normalize to dot decimal for forms |
| 3rd | Often matches **total weight (kg)** from page 1 | Used as **hint** to pick the correct triplet if several matches exist |

Heuristic: prefer the triplet whose **3rd** number equals **poidTotal** from the header; otherwise prefer a “large” middle amount.

---

## 5. Filenames (outside the PDF)

- Pattern: `\b\d{1,4}-\d{6,}\b` — e.g. `Manifeste 157-54440153 (002).pdf` → ref `157-54440153`.
- Prefer **original** manifest PDFs over `*_compressed.pdf` (annex/cache copies) when both exist; compressed files often lose or garble text.

---

## 6. Limitations

- **Image-only / scanned** PDFs with **no text layer:** nothing can be extracted until OCR exists.
- **Layout changes** (new columns, different footer shape): regexes may need updates in `manifestPdfExtract.js`.
- **Saved UI values** in `acheminement.json`: empty strings are treated as “missing” so PDF values can fill; non-empty user input wins.

---

## 7. Short prompt (for LLM / copy-paste)

Use this block when asking a model to help parse or validate a manifest PDF:

```text
You are helping extract data from a Temu-style air cargo MANIFEST PDF.

Read only what matters:
- PAGE 1: Find MAWB reference (format like 157-54440153), piece count before "Pcs", weight in kg before "kg", currency after "Currency:" or MAD/USD in the first table column.
- LAST PAGE: Find the bottom summary row with THREE numbers. The SECOND number is the total declared value (French decimals with comma, e.g. 243596,74). The third number often equals total kg from the header.

Output a JSON object: refNumber, nombreContenant (integer string), poidTotal (kg string), currency (3-letter), totalValue (use dot as decimal separator for IT systems).

If the PDF is image-only, say that text extraction is not possible without OCR.
```

---

## 8. Code entry point

Implementation: **`src/utils/manifestPdfExtract.js`** — `extractManifestMetricsFromPdfFile(pdfPath)` returns `{ ok, refNumber, nombreContenant, poidTotal, currency, totalValue, error? }`.

Scan / automation wiring: **`electron/main.js`** (`folder:scan`, `prepareLotAndWeightCheck`).
