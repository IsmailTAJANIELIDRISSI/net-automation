# PROGRESS.md — Change Log

_Append-only. Each entry = problem solved + decision made + files changed._
_Format: `## YYYY-MM-DD — <title>`_

---

## 2026-06-08 — Gemini API retry mechanism for Vision fallbacks

**Problem:** When `gemini-2.5-flash` returned 503 (high demand) or 429 (quota exceeded), the code immediately moved to `gemini-1.5-flash` (which is now deprecated → 404). This wasted the better model and caused total failure when the fallback was also unavailable.

**Fix — new `src/utils/geminiRetry.js` + updated Vision callers:**

1. **`geminiRetry.js`** — shared retry module with `geminiCallWithRetry()`:
   - **503 UNAVAILABLE**: exponential back-off on the SAME model (5s → 10s → 20s, max 3 retries) before giving up on that model
   - **429 RESOURCE_EXHAUSTED**: parse the API's `retryDelay` field from error JSON (e.g. "58s"), wait that exact duration (+1s buffer, capped at 70s), retry the same model once
   - **404 / 400**: skip to next model immediately (wrong name / bad request)
   - Prevents discarding a better model just because it had a temporary 2-second spike

2. **Wired into all Vision functions:**
   - `mawbShipperExtract.js`: `verifyShipperWithGemini()`, `extractVisionMeta()`, `supplementCurrencyFretViaVision()`
   - `manifestPdfExtract.js`: `extractManifestViaVision()`
   - All now use `geminiCallWithRetry(client, modelName, params, log)` instead of raw `client.models.generateContent()`

3. **Model fallback updated:**
   - `gemini-1.5-flash` → `gemini-2.0-flash` (stable replacement, not deprecated in v1beta API)

**Result:** Vision extraction success rate dramatically improved — 503 spikes are automatically retried, 429 quota waits are respected, and the better model (`gemini-2.5-flash`) gets multiple chances before falling back.

---

## 2026-06-08 — DUM Normale Partiel: USD manifest currency bypass

**Problem:** When filling the Entête tab for DUM Normale Partiel (Step 2), the app was always dividing `ach.totalValue` by the USD exchange rate to compute `montantTotal`, even when the manifest itself was already in USD. This created an unnecessary double-conversion: USD → MAD (in the manifest extraction) → back to USD (in the form filling), introducing rounding errors.

**Fix — `src/badr/badrDumNormalPartiel.js` `_step2_entete()`:**

- Check `ach.currency` (manifest currency, extracted from manifest PDF)
- If `currency === "USD"` → use `ach.totalValue` directly, no division
- If `currency !== "USD"` (e.g. MAD, EUR, CNY) → apply USD exchange rate conversion as before
- Added log message to show which path was taken

**Business logic:** The DUM 085 form always expects USD-denominated `montantTotal`. When the manifest is already USD-valued, we preserve precision by skipping the USD↔MAD conversion round-trip.

---

## 2026-06-08 — Déclarer scellés for DUM Normale Partiel (new step 10)

**Problem:** After the partiel DUM PDF was downloaded the automation stopped — scellés were never declared for partiel LTAs. The DS Combinée path uses DEDOUANEMENT → DS MEAD COMBINEE → Déclarer scellés DS MEAD combinée, but the partiel DUM path uses DEDOUANEMENT → Déclarer scellés (a#\_1225 / cf1225).

**Fix:**

1. **`src/badr/badrDsCombineFinalize.js`**:
   - Extracted shared form-filling into `_fillScellesForm(page, bureau, regime, annee, serie, cle, scelle1, scelle2)` private method
   - Refactored `declarerScelles` to call `_fillScellesForm` after navigation
   - Added `declarerScellesPartiel(bureau, regime, serie, cle, scelle1, scelle2)`: navigates DEDOUANEMENT → Déclarer scellés (a#\_1225) then calls `_fillScellesForm`

2. **`src/badr/badrDumNormalPartiel.js`**:
   - `_readDumRef` now returns `{ ref, serie, cle }` instead of just the string
   - `_step10_print` returns `{ destPath, serie, cle }` (DUM série/clé needed for scellés form)
   - New checkpoint `partiel_pdf_saved`: set after PDF download with `dumSerie`/`dumCle` persisted in state (crash-safe resume)
   - `partiel_done` now set only after scellés are declared (Step 10)
   - `_isDone` phase order updated: `partiel_pdf_saved` inserted before `partiel_done`
   - Step 10 lazy-requires `BADRDsCombineFinalize` and calls `declarerScellesPartiel("301", "085", dumSerie, dumCle, ach.scelle1, ach.scelle2)`

---

## 2026-06-04 — MAWB shipper extraction: second pass — mightBeCompany false positives

**Problem (follow-up to same-day fix):** After the EXCLUDE_PATTERNS + 1500-char window fix, two new false positives appeared:

- `"LIABILITY.Shipper may **INC**rease such limitation of liability…"` — `"INC"` was matching as substring of `"increase"`
- `"(**incl**.Dimensions or Volume)"` — `"INC"` matching as substring of `"incl"`

Both passed `mightBeCompany()`, so Gemini received garbage candidates and returned the first one as the shipper name.

**Fix — `src/utils/mawbShipperExtract.js`:**

1. Added `WORD_BOUNDARY_SHORT` set — short purely-alphabetic indicators (≤ 4 chars: `INC`, `LTD`, `CORP`, `TECH`) now use `\bIND\b` regex instead of `includes()`, preventing substring false positives.
2. Added **90-char length cap** to `mightBeCompany()` — sentences can never qualify as company names regardless of indicator matches.
3. Added boilerplate sentence patterns to `EXCLUDE_PATTERNS`: `limitation of liability`, `declaring a higher value`, `(incl. dimensions`, `nature and quantity`, `paying a supplemental`.

**Result:** Both false positives are now rejected → anchor window yields 0 company candidates → code falls through to full-document `allLines` scan → finds `"FUJIAN ANPORT LOGISTICS"` correctly.

---

## 2026-06-04 — MAWB shipper name extraction picks form label instead of company name

**Problem:** For MAWBs where pdf-parse reads the two-column layout by concatenating all header labels first (e.g. `"Shipper's Name and AddressConsignee's Name and AddressNot negotlable…"`), the anchor "Shipper's Name and Address" was found at position 0 but the 400-char window after it contained only other column labels — never reaching the actual company name further in the text. The candidates array was `["Consignee's Name and Address", "Not negotlable", "It is agreed…", …]`. Gemini received only garbage and fell back to returning the first line as the shipper name.

**Fix — `src/utils/mawbShipperExtract.js`:**

1. Added MAWB form-field column headers to `EXCLUDE_PATTERNS`: `consignee's name`, `shipper's name/account/reference`, `name and address`, `it is agreed`, `conditions of contract`, `shipper's attention`, `carrier's limitation`, `not neg[ao]t` (OCR variant), `copies N`, `apparent good order`, etc.
2. Increased anchor search window from **400 → 1500 chars** to skip past all header rows and reach cell content.
3. Changed anchor-path candidate filter to require `mightBeCompany()` in addition to `!shouldExclude()`. If zero company-like candidates exist in the window, logs a warning and **falls through to the full-document scan** instead of feeding garbage labels to Gemini.

---

## 2026-06-01 — Fix BADR session silently expiring during long Portnet polls + poll reload networkidle crash

**Problem 1 — BADR session expired after long poll:**
`navigateToAccueil()` has an early-return guard: when the page is already on Accueil and the menu is visible it logs "BADR session refreshed" but **returns immediately without sending any HTTP request to the BADR server**. The server-side JSF session has its own idle timer (≈ 30 min). After a long Portnet polling window, the server silently expired the session; by the time BADR was used again the browser was actually on the login/session-timeout page, requiring manual reconnect.

**Problem 2 — Consultation page poll reload timing out:**
`portnetPage.reload({ waitUntil: "networkidle" })` in the polling loop used the same networkidle pattern that caused the `goto` crash fixed earlier. On bad networks it threw `Timeout 120000ms exceeded`, logging a warning each cycle.

**Fix — `electron/main.js`:**

1. BADR refresh interval: added `badrConn.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 })` **before** `navigateToAccueil()` — this sends a real HTTP request to the BADR server on every 45-second tick, resetting the server-side session idle timer. Failure is non-fatal (warn log).
2. Consultation poll reload: `waitUntil: "networkidle"` → `"domcontentloaded"` + `timeout: 60_000`, followed by a non-fatal `waitForLoadState("networkidle", 30 s)`.

---

## 2026-06-01 — Fix consultation page goto timing out on slow networks

**Problem:** After "Envoyer DS MEAD Combinée" is clicked and the app navigates to the consultation page to poll status, `page.goto(..., {waitUntil:"networkidle"})` timed out at 120 000 ms because lingering background XHR/fetch requests on the Portnet cargo page never allowed `networkidle` to fire.

**Fix — `src/portnet/portnetDsCombine.js` `openConsultationPage()`:**

- Changed `waitUntil: "networkidle"` → `waitUntil: "domcontentloaded"` + explicit `timeout: TIMEOUT` so the goto completes as soon as the HTML is parsed
- Added a non-fatal `waitForLoadState("networkidle", 30 s)` after the goto; failure logs a warning and continues
- `_ensureConsultationSortedByCreatedAtDesc` already handles a not-yet-visible DataGrid header gracefully, so polling is unaffected

---

## 2026-05-28 — Slow-network resilience: Portnet login, DS Combinée navigate, BADR lot popup

**Problem:** On bad connections (1) Portnet home page URL changed but page wasn't fully loaded yet → subsequent steps failed. (2) DS Combinée creation page iframe wasn't ready when automation tried to interact. (3) BADR Lot de dédouanement popup took too long to appear and/or the search form wasn't ready, causing timeouts.

**Fix (3 files):**

1. **`src/portnet/portnetLogin.js`**:
   - Extended `waitForURL` timeout: 120 s → 180 s
   - Added `waitForLoadState("networkidle", { timeout: 60_000 })` after URL confirmed; failure is non-fatal (warn + continue)

2. **`src/portnet/portnetDsCombine.js` — `navigate()`**:
   - Added `waitForLoadState("networkidle", { timeout: 60_000 })` after `domcontentloaded` goto, before touching the iframe; failure is non-fatal

3. **`src/badr/badrLotLookup.js` — `openLotPopup()`**:
   - `#_437` waitForSelector timeout: 10 s → 20 s
   - Popup `waitForEvent("page")` timeout: 30 s → 60 s
   - After `domcontentloaded`: also `waitForLoadState("networkidle", 30 s)` (non-fatal)
   - Final guard: wait for `#j_id_1h:j_id_1p` (lot reference input) to be visible (30 s); if it times out, reloads the popup page and waits again before returning

---

## 2026-05-22 — DUM Normale Partiel PDF also copied to system Downloads folder

**Problem:** The printed DUM PDF was only saved inside the LTA subfolder (`Acheminements/3eme LTA/...pdf`). User had to navigate to the folder to find it — not visible in the default Downloads folder.

**Fix (`src/badr/badrDumNormalPartiel.js`):**

- Added `const os = require("os")` import
- After `download.saveAs(destPath)` in `_step10_print()`, added `fs.copyFileSync(destPath, path.join(os.homedir(), "Downloads", safeName + ".pdf"))`
- Errors during copy are caught and logged as `warn` (non-fatal — LTA folder copy is authoritative)

---

## 2026-05-19 — Per-card delete button for done LTAs + partiel_done fix

**Problem:** When an LTA finishes, the user had no way to delete just that one card/folder without running a full batch. Also `partiel_done` was not mapped to `"done"` status so partiel LTAs never showed "Terminé".

**Fix (2 files):**

1. **`src/ui/App.jsx`**:
   - `checkpointToStatus`: added `case "partiel_done": return "done"` alongside `badr_done`
   - Added `handleDelete(ach)` callback: calls `window.api.deleteDoneFolders([ach.folderPath])`, re-scans on success
   - Passes `onDelete={handleDelete}` to every `<AcheminementCard>`

2. **`src/ui/components/AcheminementCard.jsx`**:
   - Added `onDelete` prop
   - When `isDone`: replaced single button with a flex row — left 80% is a non-clickable "✓ Terminé" indicator (emerald), right 20% is a red 🗑 trash button that calls `onDelete(ach)`
   - When not done: same "Lancer" / "En cours…" / "↺ Réessayer" button as before (no `isDone` logic needed there anymore)

---

## 2026-05-11 — Auto-delete completed LTA folders after batch run

**Problem:** After a batch run where all LTAs finish, the old folders stay on disk. The next day the user must manually delete them before treating new LTAs — easy to forget.

**Fix (3 files):**

1. **`electron/main.js` — `runAllAutomationTasks`**: After `monitorPendingPortnetRequests`, collect `doneFolders` = all `toProcess` entries whose final `automationState.phase` is `badr_done` or `partiel_done`. Return `{ success: true, doneFolders }` instead of just `{ success: true }`.

2. **`electron/main.js` — new IPC handler `folder:delete-done`**: Takes `{ folders: string[] }`, shows a native `dialog.showMessageBox` confirm (Yes/Cancel) listing the folder names. If confirmed, calls `fs.rmSync(p, { recursive: true, force: true })` for each path. Returns `{ deleted: string[], cancelled: bool }`.

3. **`electron/preload.js`**: Added `deleteDoneFolders: (folders) => ipcRenderer.invoke("folder:delete-done", { folders })` to `window.api`.

4. **`src/ui/App.jsx` — `handleRunAll`**: After the batch result, if `result.doneFolders?.length > 0`, calls `window.api.deleteDoneFolders(result.doneFolders)`. If any were deleted, re-scans the folder via `window.api.scanFolder` and updates `acheminements` + `statuses` so the deleted cards disappear from the UI.

**Result:** When a batch finishes and all LTAs are done, the user gets a native dialog: "X LTA(s) ont le statut Terminé — Supprimer leurs dossiers?" with folder names listed. Yes → folders deleted, UI refreshes. Cancel → nothing deleted.

---

## 2026-05-11 — Run-All ordering: non-partial LTAs always before partials

**Problem:** "Start All" processed LTAs in the order the UI sent them (alphabetical by folder name). A partial LTA named e.g. "1er LTA" would run before a normal "2ème LTA", blocking normal LTAs unnecessarily.

**Fix (`electron/main.js` — `runAllAutomationTasks`):**
Added `.sort()` after the `.filter()` on `toProcess`:

```js
.sort((a, b) => (a.partiel === true ? 1 : 0) - (b.partiel === true ? 1 : 0))
```

Non-partial LTAs (weight 0) sort before partials (weight 1). Relative order within each group is preserved (stable sort).

---

## 2026-05-11 — BADR session timeout: auto-recovery + faster refresh

**Problem:** During Portnet polling, BADR's session expired (page: `hab_session_timeout.xhtml`, error: "Votre session est expirée !"). The 2-minute refresh was too slow (BADR times out sooner). When the popup failed, `navigateToAccueil()` was called but it just navigated to the Accueil URL without detecting the timeout state, so it arrived at the same expired-session error page, causing the whole run to fail.

**Fix (2 files):**

1. **`src/badr/badrConnection.js`**:
   - Added `_isSessionExpired()`: checks URL contains `session_timeout` OR `.ui-messages-error-detail` containing "expir" is visible
   - Added recovery block at the top of `navigateToAccueil()`: if expired → click the page's `#j_id32_j_id_1b` "Accueil" button (which calls `allerLogin('/badr')`) → wait 1.5s → call `navigateAndLogin()` → return. Full re-login happens transparently.

2. **`electron/main.js`**:
   - Reduced BADR session refresh interval from `120000` ms → `45000` ms (45 seconds) to prevent timeout from occurring in the first place.

**Result:** Any call to `navigateToAccueil()` (during polling refresh, popup reconnect, or step retry) now auto-heals a timed-out session before proceeding.

---

## 2026-05-11 — Python script: Gemini Vision extraction for scanned MAWBs

**Task:** Mirror the JS `extractVisionMeta` pattern from `mawbShipperExtract.js` into the Python script `extract_shipper_example/script_all_fuzy_match.py`.

**Changes:**

- Added `extract_vision_meta(pdf_path)` function:
  - Reads the PDF as base64
  - Sends it to Gemini Vision (`application/pdf` inline data) with a single prompt asking for shipper name, currency, and total prepaid
  - Falls back through `GEMINI_MODEL_FALLBACKS` (gemini-3.1-flash-lite-preview → gemini-2.5-flash → gemini-1.5-flash)
  - Returns `(shipper_name, mawb_currency, fret_value)` tuple — any value may be `None`
  - Strips markdown code fences from Gemini response before JSON parse
- Modified `extract_shipper_name()` image-based branch:
  - If `setup_gemini_api()` succeeds → calls `extract_vision_meta(pdf_path)` first
  - If Vision returns a shipper name → cleans it with `clean_company_name`, adds to DB, returns immediately (skip OCR pipeline entirely)
  - If Vision returns nothing → falls through to existing OCR pipeline (ocrmypdf → tesseract → pdftotext)

**Why:** OCR pipeline (tesseract/ocrmypdf) is slow, requires system tools, and is fragile on flattened-layout scanned MAWBs. Gemini Vision handles these in one API call with no system dependencies.

---

## 2026-05-11 — Devise MAWB: free-text input + remove USD fallback

**Problem:** Devise MAWB was a fixed `<select>` (USD/EUR/HKD/CNY/GBP/AED/MAD). When extraction returned an unlisted code (e.g. `MYR`), the `?? "USD"` fallback in `folder:scan` silently substituted USD, causing wrong exchange rate in the Articles tab.

**Fix:**

- Replaced `<select>` with a free-text `<input maxLength={3}>` that auto-uppercases on change (`e.target.value.toUpperCase()`). Any 3-letter ISO currency code works without a code change.
- Removed `?? "USD"` fallback in `main.js` folder:scan handler — empty string is returned when extraction finds nothing, so the user sees a blank field and must fill it manually.
- `MYR` was already in `KNOWN_CURRENCY_RE` in `mawbShipperExtract.js` — extraction was correct, only the UI/fallback was broken.

**Files changed:**

- `src/ui/components/AcheminementCard.jsx` — select → input with toUpperCase
- `electron/main.js` — `?? "USD"` → `?? ""`

---

## 2026-05-08 — DUM Normale Partiel: progressive fixes (selectors, lieu autocomplete, documents, poids correction)

**Problems fixed (in order):**

1. **Radio "Création à partir d'une déclaration existante" never clicked** — `<input>` is inside `div.ui-helper-hidden-accessible`; Playwright blocks hidden elements. `.catch(() => {})` silently swallowed the failure. Fixed: click `table#rootForm:modeTransport_radioId2 .ui-radiobutton-box` (the visible PrimeFaces widget). AJAX populates `#rootForm:panelRefDecExistante`; reference fields filled by exact IDs (`refExist_bureauId`, `refExist_anneeId`, `refExist_serieId`, `refExist_cleId`). Régime is readonly (085), skipped.

2. **Lieu de chargement autocomplete not selected** — was using `isVisible({ timeout })` which doesn't poll, so script moved on before dropdown appeared. Fixed: `waitFor({ state: "visible", timeout: 10000 })` + `.filter({ hasText: p.lieu })` to pick the right item (e.g. `ISTAMBOUL ATATUR(IST)` not `ISTAMBOUL(TRIST)`).

3. **`p.ref` contained scraped whitespace + ETAT trailer** — `"235-97484855\n\t\t\t...ETAT : PreapureAcquisCaution"`. Fixed: `String(p.ref).split(/[\r\n]/)[0].trim()` keeps only first line.

4. **`compressPdfChain is not a function`** — export name is `compressPdfForAnnex`, not `compressPdfChain`. Also return value is `{ uploadPath, mode }` not a plain string. Fixed import and destructuring.

5. **Upload verification used `isVisible` (single check)** — changed to `waitFor({ state: "visible", timeout: 15000 })` so it retries until the table row appears.

6. **Filename > 50 chars** — iLovePDF temp file `portnet_annex_ilove_primary_<ts>_Manifeste 235-97484855.pdf` exceeded BADR's 50-char limit. Fixed: build short name from `<reference>_<originalStem>.slice(0, 45).pdf` (e.g. `fac_Manifeste_235-97484855.pdf` = 29 chars).

7. **Poids rounding mismatch (1583 vs 1583.1)** — BADR lots report fractional kg while manifest stores integer. Old threshold was > 20 kg → mismatch error. New logic:
   - diff > 1 kg → log `TODOMAIL`, throw error, mark `partiel_poids_mismatch`
   - diff ≤ 1 kg → update `ach.poidTotal` in-memory, navigate back to Entête tab and re-fill `poidBrutTotal_input` with authoritative value, then save. Subsequent steps (Articles: poids net, qté normalisée) use corrected value naturally.
   - New helper `_correctEntePoids(iframe, poids)` added.

**Files changed:**

- `src/badr/badrDumNormalPartiel.js` — all 7 fixes above

---

## 2026-05-08 — MAWB: scanned PDF support + currency + fret value auto-extraction

**What:** Extended MAWB extraction to handle scanned (image-based) PDFs and to auto-extract `mawbCurrency` and `fretValue` (Total Prepaid) in addition to the shipper name.

**Problem:** Scanned MAWBs (e.g. 065-46093530.pdf from Saudi Arabian Airlines) produced only 2 characters via `pdf-parse`, so shipper extraction returned null. Also, `mawbCurrency` and `fretValue` were never auto-populated — users had to type them manually.

**Solution:**

- Replaced single-purpose `extractWithGeminiVision` with `extractVisionMeta` — sends raw PDF bytes (base64) to Gemini Vision, asks for **all 3 fields** (`shipper_name`, `currency`, `total_prepaid`) in one API call. No local OCR/Tesseract needed.
- Added `extractMetaFromText(text, log)` — regex-based fallback for text-based PDFs: finds currency code near the "Currency" label; finds amount near "Total Prepaid" label.
- Added `extractMawbMeta(pdfPath, knowCompaniesPath, log)` as the new main entry point → returns `{ shipperName, mawbCurrency, fretValue }`.
- Kept `extractShipperName` as a backward-compat thin wrapper.

**Files changed:**

- `src/utils/mawbShipperExtract.js` — `extractVisionMeta`, `extractMetaFromText`, `extractMawbMeta`, updated `module.exports`
- `electron/main.js` — import `extractMawbMeta`, both call sites updated, all 3 fields persisted to `acheminement.json`, returned in IPC response
- `src/ui/App.jsx` — `.then` handler updated to apply `mawbCurrency` and `fretValue` to card state

**Decisions:**

- Gemini Vision gets one call for all 3 fields (scanned path) — avoids 2–3 separate API calls
- Text-based path uses regex; currency code from within 120-char window after "Currency" label

---

**What:** Implemented all 8 tasks for DUM Normale Partiel BADR automation.

**Files changed:**

- `src/utils/manifestPdfExtract.js` — added `extractFooterTriplet()`, wired `qteFacturee` into output
- `src/utils/mawbShipperExtract.js` — CREATED: extracts shipper from MAWB PDF via `known_companies.json`
- `src/utils/exchangeRate.js` — CREATED: `fetchMADRate(currency)` with 3-provider fallback (BAM→frankfurter→OXR), `roundBADR(value)`
- `src/ui/components/AcheminementCard.jsx` — added 4 partiel inputs (`shipperName`, `fretValue`, `mawbCurrency`, `qteFacturee`) in yellow panel
- `src/badr/badrLotLookup.js` — `rowCount>=2` now collects all rows into `partiels[]` array (serie/cle/lieu/ref per row)
- `src/badr/badrDumNormalPartiel.js` — CREATED: 10-step BADR DUM 085 class, all tabs, checkpointed per phase
- `electron/main.js` — SAVED_FIELDS + scan shipper wiring + `runPartielDumFlow()` function + partiel routing in `runAutomationTask` + `runAllAutomationTasks` + phase map extended with 12 partiel phases

**Decisions:**

- Exchange rate is a direct Node utility (not an HTTP endpoint on `index.js`) — simpler, no network round-trip
- `prepareLotAndWeightCheck` partiel-skip guard kept (harmless; partiel is intercepted earlier in `runAutomationTask`)
- Poids mismatch threshold for partiel: >20 kg → hard stop with `partiel_poids_mismatch` phase

---

## 2026-05-07 — DUM Normale Partiel — structured automation spec written

**What:** Reformulated and structured `DUM-NORMAL-PARTIEL-PROMPT.md` from raw notes into a full implementation spec for automating the BADR DUM 085 (Transit à l'import) declaration flow for partiel LTAs.

**Spec covers:**

- 4 new AcheminementCard inputs when `partiel=true`: `shipperName`, `fretValue`, `mawbCurrency`, `qteFacturee`
- `manifestPdfExtract.js` change: extract `qteFacturee` (1st number of footer triplet)
- New `mawbShipperExtract.js` for shipper name from MAWB PDF via `know_companies.json`
- `/exchange-rate` endpoint in `index.js` (BAM → frankfurter → OXR fallback chain)
- `badrLotLookup.js` partiel mode: collect all rows into `partiels[]` array; halt if <2
- New `badrDumNormalPartiel.js` class with 10-step BADR form flow, checkpointed per tab
- 12-phase state machine for partiel LTAs (`partiel_lots_found` → `partiel_done`)
- Validation: poids sum check after Préapurement loop; clear error phases on mismatch

**Files touched:** `DUM-NORMAL-PARTIEL-PROMPT.md` (rewritten), `ai-docs/PROGRESS.md`, `ai-docs/TASKS.md`

---

## 2026-04-28 — Prevent duplicate BADR finalization after LTA already completed

**Problem:** Some LTAs were finalized twice on BADR. Logs showed `Workflow fully complete for "7eme LTA"!` followed immediately by another `Proceeding to finalize on BADR for "7eme LTA"...` sequence.

**Root cause:** In `monitorPendingPortnetRequests()`, the pre-loop resume block called `finalizeAcceptedOnBadr()` for any state with `badrRef`, including LTAs already marked `phase = "badr_done"`.

**Fix:** Added a phase guard so resume finalization only runs for accepted-but-not-completed LTAs:

- From: `if (state.badrRef) { ... }`
- To: `if (state.badrRef && state.phase !== "badr_done") { ... }`

This prevents re-running BADR finalization once an LTA is already completed.

**File changed:** `electron/main.js`

---

## 2026-04-23 — BADR DEDOUANEMENT menu stuck (hidden items) — retry with Accueil refresh

**Problem:** After phase 1 (PDF download popup closes), calling `declarerScelles()` expands DEDOUANEMENT but the PrimeFaces menu items `a#_205151` (DS MEAD COMBINEE) and `a#_12251` (Déclarer scellés) resolve as hidden elements, causing 15 s timeouts. Example log: `locator resolved to hidden <a id="_205151"...>` repeated 32×.

**Root cause:** The PrimeFaces accordion menu doesn't always re-render child items as visible after a prior popup closes in the same BADR page session. A full Accueil navigation resets the menu state.

**Fix:** Wrapped the DEDOUANEMENT → DS MEAD COMBINEE → Déclarer scellés click sequence in a `for` loop (max 3 attempts). On `waitFor({ state: "visible" })` timeout, logs a warning and calls `badrConn.navigateToAccueil()` (falls back to `page.reload()` if no badrConn) before retrying from the beginning of the DEDOUANEMENT expansion. Also bumped `waitForTimeout` after each menu click from 500 ms to 700 ms for extra stability.

**File changed:** `src/badr/badrDsCombineFinalize.js`

---

## 2026-04-23 — Retry full Portnet form fill when status is "Nouveau" (draft) after submit

**Problem:** After clicking Envoyer on the Portnet DS Combinée form, the consultation page sometimes showed status `Nouveau` (draft — not actually sent). The monitoring loop had no handling for this: it kept polling indefinitely, never detecting the form was never submitted.

**Fix:** Two changes in `electron/main.js`:

1. Added `isNouveauStatus(statusText)` helper (mirrors `isEnvoyeeStatus` / `isRejectedStatus`) using `normalizePortnetStatus(statusText).startsWith("nouveau")`.

2. In `monitorPendingPortnetRequests`, added a new `else if (isNouveauStatus(statusText) && attempts > 2)` branch in the status-check chain. When triggered:
   - Releases the claimed row anchor (`claimedRowAnchors.delete`)
   - Preserves `state.lotInfo` (BADR-confirmed sequence + weight — no need to re-query BADR)
   - Clears `portnetRef`, `submittedAt`, `consultationCreatedAtRaw`, `consultationNumeroManifeste`, `attempts` from checkpoint
   - Increments `nouveauRetryCount` (max 3 retries; 4th attempt marks as error requiring manual intervention)
   - Reads fresh user data from `readAcheminementFile` for any last-minute edits
   - Calls `submitPortnetPhase(retryAch, savedLotInfo, portnetPage)` to re-fill and re-send the form
   - On success, re-adds the LTA to the `pending` Map so monitoring continues

**File changed:** `electron/main.js`

---

## 2026-04-22 — Manifest PDF total value extraction: footer concatenation bug fixed

**Problem:** `extractedValue 216555.04` instead of correct `16555,04`. Root cause: `renderPageToText` concatenated same-Y items without spaces, so the footer row `2112 | 16555,04 | 870` became `"211216555,04870"`. The prefix-split fallback then tried prefix-length 3 first: prefix=`211`, value=`216555` → wrong `216555.04`.

**Fix 1 — `renderPageToText`:** Added a space between consecutive items on the same Y coordinate (`if (text !== "" && lastY != null) text += " "`). The triplet pattern `(\d+)\s+(\d+,\d{2})\s+(\d+)` now cleanly matches `2112 16555,04 870`.

**Fix 2 — coordinate-aware footer extraction (user's suggestion):** Added `extractPageFooterText(page)` that:

- Filters text items to the bottom third of the page (Y ≤ minY + range/3)
- Groups items by approximate Y row (±3 units), sorts each row left→right by X coordinate
- Joins with spaces → clean `"2112 16555,04 870"`

`extractFirstAndLastPageTexts` now returns an additional `footerText` field. `extractManifestMetricsFromPdfFile` tries `footerText` first (most reliable), then falls back to `lastPageText` as before.

**File changed:** `src/utils/manifestPdfExtract.js`

---

## 2026-04-22 — Editable "Manifest ref LTA" field for refMismatch cases

**Problem:** When Abdelhak creates a manifest with a wrong LTA reference (filename says `157-53609710` but PDF header says a different ref), the app showed a red mismatch warning and blocked the Lancer button. The only fix was to email Abdelhak and wait for him to fix the manifest PDF — slow.

**Fix:** Added an editable "Manifest ref LTA" input that appears inside the mismatch warning block in `AcheminementCard`. It pre-fills with the manifest PDF's extracted `refNumber`. When the user types the correct reference:

- It is saved to `acheminement.json` via the existing `acheminement:save` IPC channel (new `manifestRef` field added to `SAVED_FIELDS`).
- `prepareLotAndWeightCheck` now resolves `refNumber` with `manifestRef` as highest priority (before filename-based ref).
- `runAllAutomationTasks` filter now allows acheminements with `refMismatch` through if `manifestRef` is set.
- The Lancer button becomes enabled once `manifestRef` is non-empty (disabled condition updated).

**Files changed:** `src/ui/components/AcheminementCard.jsx`, `electron/main.js`

---

## 2026-04-21 — Portnet "Contactez-nous" widget removed before Créer click

**Problem:** Portnet added a Click2Connect "Contactez-nous" floating widget inside the iframe. It renders on top of the form and intercepts clicks on the `Créer` submit button in `fillCaution`, causing the automation to click the widget instead of submitting the form.

**Fix:** In `fillCaution()`, before clicking `Créer`, use `locator.evaluate()` to remove the widget's root container from the iframe DOM. The widget is identified by `[class*="Click2ConnectButton"]`; its root container is found via `closest('[style*="--verticalGradientStartColor"]')`. The `.catch(() => {})` makes it a no-op when the widget is absent (other sessions / future rollback).

**File changed:** `src/portnet/portnetDsCombine.js`

---

## 2026-04-28 — Portnet "Contactez-nous" widget blocks Créer again — robust multi-pass removal

**Problem:** The floating "Contactez-nous" (Click2Connect) widget overlays the Portnet form and blocks the Créer button, preventing form submission. The widget's DOM structure or injection timing changed, so the previous single-pass removal was not always effective.

**Fix:** In `fillCaution()` (PortnetDsCombine), replaced the old single `.first().evaluate()` widget removal with a robust multi-pass strategy:

- Removes _all_ elements matching `[class*="Click2ConnectButton"]` and their closest parent with the vertical gradient style
- Also removes any element with text `Contactez-nous` and a suspicious style
- Retries up to 3 times with a short delay if the widget is still present

**File changed:** `src/portnet/portnetDsCombine.js`

---

## 2026-04-15 — Manifest PDF extraction: leading zero in value + currency source of truth

**Problem 1 — Leading zero in extracted value:** Footer value `13683,15` was extracted as `013683.15` instead of `13683.15`. Root cause: PDF text concatenates footer columns as `354013683,15` (no space). The split-by-6-digits logic sliced `013683` as a raw string and returned it verbatim — not stripping the leading zero.
**Fix:** Replace `return \`${valueInt}.${decPart}\``with`return \`${parseInt(valueInt, 10)}.${decPart}\`` in both helper functions (`extractValue`in`extractFooterTotalLineFallback`and`extractValueFromChunk`in`extractFooterTotalValue`). Also fixed the `intPart.slice(-7)` last-resort return the same way.

**Problem 2 — Wrong currency from header vs table:** Manifest sender sometimes writes wrong currency in the first-page header (e.g. `Currency:MAD`) while every table row actually says `USD`. The code trusted the header.
**Fix:** Added `extractCurrencyFromTableRows(text)` that counts all `MAD/USD/EUR/...` occurrences across both page texts. Table rows each start with the currency → they dominate the count (100s of occurrences) vs header (1-2). Threshold: >2 votes. In `extractManifestMetricsFromPdfFile`, this is now applied **unconditionally** — it overrides the header currency whenever the table gives a dominant result. The old `extractCurrencyFromTableColumn` is kept as a fallback when no dominant currency is found.

**File changed:** `src/utils/manifestPdfExtract.js`

---

## 2026-04-14 — Portnet consultation reload crash fixed (batch no longer stops)

**Problem:** After each poll interval, `portnetPage.reload()` + `_ensureConsultationSortedByCreatedAtDesc()` is called. Inside that method, `createdAtHeader.waitFor({ state: "visible", timeout: 30000 })` threw a hard timeout when Portnet was slow to render the iframe (e.g. after 2+ hours of polling). The exception propagated all the way up to `runAllAutomationTasks`'s catch block → "Batch run failed" — killing all polling even though LTAs were still pending.

**Fix:**

1. `src/portnet/portnetDsCombine.js` — `_ensureConsultationSortedByCreatedAtDesc`: replaced `await waitFor(...)` (throws on timeout) with `.then(()=>true).catch(()=>false)`. If the header isn't visible in 30s, logs a warning and returns — sort will be retried next cycle, polling continues.
2. `electron/main.js` — `monitorPendingPortnetRequests`: wrapped the `portnetPage.reload()` + `_ensureConsultationSortedByCreatedAtDesc()` block in try/catch. If reload itself fails, logs a warning, waits 5s, and continues the while loop — never crashes the batch.

**Files changed:** `src/portnet/portnetDsCombine.js`, `electron/main.js`

---

## 2026-04-14 — BADR MISE EN DOUANE expand check fixed (ui-state-active)

**Problem:** `badrLotLookup.js` and `badrDsCombineFinalize.js` checked visibility of `#_150` to decide whether to click the MISE EN DOUANE header. When the menu was already expanded on the Accueil page, `#_150` could still appear invisible to Playwright (mid-animation or rendering edge case), causing the code to click the header and **collapse** it instead of expanding it.

**Fix:** Replace `#_150` visibility check with a `classList.contains("ui-state-active")` check on the `h3.ui-panelmenu-header` that contains "MISE EN DOUANE". BADR adds `ui-state-active` + `ui-corner-top` classes and changes the icon to `ui-icon-triangle-1-s` only when truly expanded — this is the definitive signal. If `ui-state-active` is present → already expanded, skip click; otherwise → collapsed, click to expand.

**Files changed:** `src/badr/badrLotLookup.js`, `src/badr/badrDsCombineFinalize.js`

---

## 2026-04-13 — BADR finalize popup timeout fix + session reconnect

**Problem:** `BADRDsCombineFinalize.downloadAutorisationEntree` used a single `page.waitForEvent("popup")` (default 120s timeout) immediately after expanding menus. On first run it always timed out; outer retry succeeded instantly because menus were already expanded. Additionally, if BADR tab is truly disconnected/stale during the popup wait, the error propagates with no reconnect attempt.

**Root cause (popup timing):** Not a session issue — BADR was being refreshed every 2 minutes during Portnet polling (confirmed in logs). The 400ms settle after `expandMenuNode` was insufficient; `a#_436` click fired before the BADR menu was fully ready, popup never opened.

**Root cause (session):** When BADR tab goes stale (e.g. Edge was closed externally or session expired mid-wait), the outer retry lands back with a dead page. Without reconnect inside the finalizer, it could fail again immediately.

**Fix:** In `src/badr/badrDsCombineFinalize.js`:

- Constructor now accepts optional `badrConn` (3rd param, default null)
- Added `declarationLink.waitFor({ state: "visible" })` + `page.waitForTimeout(800)` after menu expansion
- Replaced single 120s popup wait with 3 attempts × 20s each
- After all 3 fail: if `badrConn` present → tries `navigateToAccueil()` (soft reconnect); if that also throws → does full `navigateAndLogin()` + `navigateToAccueil()`; updates `this.page = badrConn.page`; then rethrows so outer retry runs with a live session

In `electron/main.js`: passes `badrConn` as 3rd arg to `new BADRDsCombineFinalize(badrConn.page, undefined, badrConn)`

**Effect:** Self-heals on attempt 2 for UI timing flakiness (~20s), and on full session death it reconnects BADR before the outer retry (no manual intervention needed).

**Files changed:** `src/badr/badrDsCombineFinalize.js`, `electron/main.js`

---

## 2025 — Initial Development

### Architecture decisions made during build

- Chose Electron over pure CLI to support manual CAPTCHA interaction (CAPTCHA requires human in loop for Portnet login). React UI wraps the automation and provides real-time log feed.
- BADR uses CDP remote debugging against Edge (not a standalone Playwright browser) because BADR requires a USB digital certificate that only authenticates in the user's existing Edge profile. Wiring Edge via CDP was the only viable approach.
- All automation state checkpointed to `acheminement.json` per LTA folder so runs can resume after crash without repeating completed phases.
- Portnet form fills all go through `this.frame` (FrameLocator) because the DS Combinée UI lives inside a cross-origin iframe at `manifeste-prod.portnet.ma`.
- PDF compression uses iLovePDF × 3 accounts → Adobe → first+last fallback to stay under Portnet's 2 MB upload limit even when API quotas are exhausted.
- `manifestPdfExtract.js` reads only first+last page of manifest PDFs (can be 200+ pages) for performance. Regex patterns tuned for the MAWB/manifest format used by RAM (Royal Air Maroc) cargo manifests.

---

## 2026 — Production fixes

### 2026-04-10 — Manifeste compression safe-threshold 1900 KB

**Problem:** Portnet sometimes rejected a compressed manifeste PDF that was ~1994 KB (just under the 2 MB limit), likely due to server-side tolerance issues.

**Fix:** Added `SAFE_BYTES = 1900 * 1024` (1900 KB) as the acceptance threshold for compressed results in `src/utils/compressPdfChain.js`. If the API-compressed result is > 1900 KB (even if < 2 MB), the function now discards it and falls through to the first+last page fallback. `MAX_BYTES` (2 MB) is kept for the skip-if-small check and the hard limit in `portnetDsCombine.js`.

**File changed:** `src/utils/compressPdfChain.js` — added `SAFE_BYTES` constant; replaced both iLovePDF and Adobe `sz <= MAX_BYTES` acceptance checks with `sz <= SAFE_BYTES`.

### 2026-04-09 — MAWB compression via Ghostscript (free, no API keys)

**Problem:** MAWB PDFs can exceed 2 MB (Portnet hard limit). The existing iLovePDF/Adobe chain was designed for manifeste only. MAWB needs a free, local, zero-API-key approach.

**Solution:** Added `compressMawbGhostscript(filePath, log)` in `src/utils/compressPdfChain.js`:

- Skips entirely if file ≤ 2 MB.
- Detects GS binary: scans `C:\Program Files\gs\<version>\bin\gswin64c.exe` (newest first), then falls back to PATH commands (`gswin64c`, `gswin32c`, `gs`).
- Progressive compression: `/printer` (300 dpi) → `/ebook` (150 dpi) → `/screen` (72 dpi) — stops as soon as ≤ 2 MB is achieved.
- Validates each output with `isLikelyValidPdf()` (checks `%PDF-` header + `%%EOF` trailer) before accepting.
- If target not reached after all levels, uses best (smallest valid) result with a warning.
- If GS not installed, logs a warning and submits original file.

**Files changed:**

- `src/utils/compressPdfChain.js` — added `findGsBinary()`, `compressMawbGhostscript()`, exported it.
- `src/portnet/portnetDsCombine.js` — imported `compressMawbGhostscript`; added optional `compressFn` param to inner `uploadFile`; passes `(fp) => compressMawbGhostscript(fp, log)` for MAWB only. Manifeste path unchanged.

### 2026-04-09 — Sort LTAs numerically on folder scan

**Problem:** `fs.readdirSync` returns folders in alphabetical order. Folder names like `10eme LTA`, `11eme LTA`, `12eme LTA` sort before `7eme LTA`, `8eme LTA`, `9eme LTA` because `"1" < "7"` lexicographically.

**Fix:** Added `.sort()` on the `acheminements` array before returning in the `folder:scan` IPC handler (`electron/main.js`). Sort key is `parseInt(entry.id, 10)` so numeric order is preserved regardless of number of digits.

**File changed:** `electron/main.js` — `folder:scan` handler, just before `return acheminements`.

---

### 2026-04-09 — Fix sendLog not writing to log file

**Problem:** `sendLog()` in `electron/main.js` sent logs directly to the renderer via `webContents.send()` but never called `writeToFile`. All orchestration-layer log messages (portnet monitoring loop, polling status, anchor messages, BADR orchestration) were visible in the UI log panel during the session but **never saved to the log file**. After app restart, those logs were lost.

**Root cause:** Two separate log paths existed:

- `createLogger()` in `src/utils/logger.js` → `write()` → `writeToFile()` + `logEmitter.emit()` → renderer (used by `portnetDsCombine.js` class internals)
- `sendLog()` in `main.js` → `webContents.send()` directly → renderer only (used by all orchestration/monitoring code)

The second path made `sendLog` calls invisible in log files.

**Fix applied in two files:**

1. `src/utils/logger.js` — exported the `write` function:
   - Added `write` to `module.exports`.

2. `electron/main.js` — rewired `sendLog` to use `write`:
   - Calls `require("../src/utils/logger").write(level, context, message)` which handles file write + console.log + logEmitter → renderer.
   - Fallback (try/catch) keeps direct `webContents.send` if logger is unavailable.
   - Removes duplicate direct `webContents.send` from normal path (logEmitter listener in `setupLogForwarding` now handles renderer delivery).

**Behavior after fix:** All logs (portnet submission, polling, BADR, row anchors) are now saved to `logs/automation-YYYY-MM-DD.log`.

### 2026-04-09 — Fix consultation row collision (multi-LTA same portnetRef)

**Problem:** When ≥2 LTAs share the same `portnetRef` (same flight/lot), `captureSubmittedRowAnchor` times out (45s) because Portnet rows appear 30-60 min after submit. All LTAs then enter monitoring with no anchor. Without anchors, `getConsultationStatus` returns the same newest row (table sorted descending) for every LTA. The first LTA claims that row's `refDsMead`. The remaining LTAs are locked to the same wrong row but can't read `refDsMead` because it's already claimed — infinite loop.

**Root cause confirmed:** `consultationCreatedAtRaw` was `null` for all LTAs after submission, so all fell through to the same default selection (newest row = wrong row for all but one).

**Fix applied in two files:**

1. `electron/main.js` — `monitorPendingPortnetRequests`:
   - Added `claimedRowAnchors: Set` tracking `"createdAtRaw::manifeste"` keys.
   - Pre-populate from already-anchored LTAs so new runs don't re-claim existing rows.
   - Anchor lock-in now checks `claimedRowAnchors` before saving — skips if already taken.
   - Recovery logic: when `isAcceptedStatus && !refDsRaw && attempts > 3` → clear stale anchor and remove from `claimedRowAnchors` so next poll finds a different row.
   - Passes `excludeCreatedAt` (built from `claimedRowAnchors`, minus own anchor) to `getConsultationStatus`.

2. `src/portnet/portnetDsCombine.js` — `getConsultationStatus`:
   - New `excludeCreatedAt` option (array of `{createdAtRaw, manifeste}` objects).
   - Built into `excludeCreatedAtSet` (Set of `"createdAtRaw::manifeste"` strings).
   - Applied in time-window fallback path: filters `allMatches` to `unclaimedMatches` before selecting.
   - Applied in no-submittedAt fallback path: added exclusion filter to `acceptedCandidates`.

**Behavior after fix:**

- Each newly appearing row gets claimed by exactly one LTA (first-come first-served).
- Stale anchors (pointing to already-claimed rows) are auto-cleared after 3 failed polls.
- Subsequent polls find a different unclaimed row for each LTA.
- Natural ordering: earliest-submittedAt LTA tends to pick earliest-createdAt row because time-window proximity sorting aligns submission → creation order.

## 2026 — ai-docs bootstrap

### 2026-03-12 — Initial ai-docs creation

- Problem: no persistent agent memory across sessions; agent kept re-scanning codebase.
- Solution: Created `/ai-docs/PROJECT.md`, `STACK.md`, `PROGRESS.md`, `TASKS.md` from full codebase analysis.
- Files changed: all four ai-docs files created.
