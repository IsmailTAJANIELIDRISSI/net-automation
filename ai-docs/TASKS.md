# TASKS.md — Current State & Next Steps

## Current State

The core automation flow is **fully implemented and working in production**:

- BADR lot lookup ✅
- BADR pré-apurement weight check ✅
- Portnet DS Combinée form (all 9 steps) ✅
- PDF compression chain (iLovePDF → Adobe → fallback) ✅
- **DUM Normale Partiel (BADR DUM 085) — fully implemented, in active testing ✅**
  - 4 UI inputs per partiel LTA (shipperName, fretValue, mawbCurrency, qteFacturee)
  - Exchange rate utility (BAM → frankfurter → OXR)
  - MAWB shipper extraction
  - Lot lookup collects all partiel rows (partiels[] array)
  - `badrDumNormalPartiel.js`: 10-step BADR form, checkpointed per tab
  - 12-phase state machine in main.js
  - Step 1: radio + reference fields + checkbox ✅
  - Step 2 (Entête): USD currency bypass — if manifest currency is USD, use totalValue directly without exchange rate conversion (preserves precision) ✅
  - Step 5: lieu autocomplete wait + item matching ✅; ref cleaned ✅
  - Step 5: poids rounding correction (≤1 kg → auto-fix Entête + Articles) ✅
  - Step 6: compressPdfForAnnex wired; short filename (≤49 chars); upload waitFor ✅
  - Devise MAWB: free-text input (auto-uppercase), any ISO code accepted ✅
- **MAWB auto-extraction: shipper + currency + fret value ✅** (2026-05-08)
  - Scanned PDFs: Gemini Vision reads image-based MAWBs natively (no OCR tool needed)
  - Text-based PDFs: regex extracts currency code + Total Prepaid amount
  - `mawbCurrency` and `fretValue` auto-populated when partiel checkbox is enabled
- **Per-card delete button for done LTAs ✅** (2026-05-19)
  - When status = Terminé: button row splits 80% "✓ Terminé" (unclickable) + 20% 🗑 trash button
  - Trash click → native confirm dialog → folder deleted → UI re-scans
  - `partiel_done` now correctly maps to `"done"` status (was falling to `"idle"`)
- **DUM Normale Partiel PDF copied to system Downloads ✅** (2026-05-22)
  - After saving PDF in LTA folder, also `copyFileSync` to `~/Downloads/` with same filename
  - Copy failure is non-fatal (warn log only)
- **Scellés declaration for DUM Normale Partiel ✅** (2026-06-08)
  - `declarerScellesPartiel` in `badrDsCombineFinalize.js`: DEDOUANEMENT → Déclarer scellés (a#\_1225)
  - `_fillScellesForm` extracted — shared by DS Combinée and partiel paths (no code duplication)
  - `badrDumNormalPartiel`: Step 9 → PDF download (sets `partiel_pdf_saved` + persists `dumSerie`/`dumCle`), Step 10 → scellés (sets `partiel_done`)
  - Crash-safe: `dumSerie`/`dumCle` persisted in `acheminement.json`; resume from `partiel_pdf_saved` goes straight to scellés
- **MAWB shipper extraction form-label bug ✅** (2026-06-04)
  - Anchor window 400 → 1500 chars; candidates filtered by `mightBeCompany()`
  - Added MAWB column-header exclusion patterns; falls back to full-document scan when no company candidate in window
- **BADR session silent expiry fix ✅** (2026-06-01)
  - Refresh interval now forces `page.reload(domcontentloaded)` before `navigateToAccueil()` — real HTTP request every 45 s
  - Consultation poll reload: `networkidle` → `domcontentloaded` + non-fatal `networkidle` wait
- **Consultation page goto timeout fix ✅** (2026-06-01)
  - `openConsultationPage()`: `waitUntil:"networkidle"` → `"domcontentloaded"` + non-fatal `networkidle` wait
  - Prevents 120 s hard crash on slow networks after DS submission
- **Slow-network resilience ✅** (2026-05-28)
  - `portnetLogin.js`: `waitForURL` 120 s → 180 s; `networkidle` wait after URL confirmed
  - `portnetDsCombine.js` `navigate()`: `networkidle` wait before touching iframe
  - `badrLotLookup.js`: popup event timeout 30 s → 60 s; form input guard with auto-reload fallback

- **Manifest PDF "Invalid PDF structure" — Gemini Vision fallback ✅** (2026-06-09)
  - `extractManifestViaVision(pdfPath)` in `manifestPdfExtract.js`: sends PDF as base64 to `gemini-2.5-flash` (fallback `gemini-2.0-flash`), extracts all 6 fields (refNumber, nombreContenant, poidTotal, currency, totalValue, qteFacturee) from the manifest
  - Wired into the catch block of `extractManifestMetricsFromPdfFile` — transparent upgrade: pdf-parse tries first, Vision fires only on parse failure
  - Console logs file size + error reason before fallback attempt (debug aid)
  - Exported as `extractManifestViaVision` for optional direct use
  - Success log in `main.js` now shows `qteFacturée` and `(via gemini-vision:…)` source tag
  - Warn log enhanced with actionable hint based on error type (Invalid PDF / no_header_match / gemini_failed)

- **Gemini API robust retry mechanism ✅** (2026-06-09)
  - `src/utils/geminiRetry.js` — shared `geminiCallWithRetry()` for 503/429 transient errors
  - 503 UNAVAILABLE: exponential back-off (5s/10s/20s) on same model before fallback
  - 429 RESOURCE_EXHAUSTED: parse API's `retryDelay` field, wait exact duration (e.g. 58s), retry same model once
  - Wired into all Vision functions: MAWB shipper/currency/fret extraction + manifest extraction
  - Model fallback updated: `gemini-1.5-flash` → `gemini-2.0-flash` (not deprecated)

## Next Steps / Testing

- [ ] Verify upload table selector `#mainTab:form7:listFichiersAnnexeDT_data` matches real DOM — if upload verify still fails, paste table HTML
- [ ] Verify Caution `li[data-label='S2021000002']` label matches exact BADR UI text
- [ ] Verify Demandes Diverses textarea structure (scellés replace pattern)
- [ ] Check if `a[href='#mainTab:tab11']` is the correct transport tab anchor
- [ ] Check if `a[href='#mainTab:tab0']` is the correct Entête tab anchor (used in `_correctEntePoids`)
- [ ] Email notifications — TODOMAIL poids mismatch > 1 kg is now logged; wire nodemailer

- Portnet polling for Acceptée/Rejetée ✅
- BADR finalize (scellés declaration) ✅
- Electron UI with per-LTA cards and live log panel ✅
- Checkpoint/resume system ✅

---

## Next: DUM Normale Partiel Automation (spec ready in DUM-NORMAL-PARTIEL-PROMPT.md)

Full implementation spec written. Implement in this order:

### Phase 0 — Prep (no BADR automation yet)

- [ ] `manifestPdfExtract.js` — add `qteFacturee` (1st footer triplet number) to returned object
- [ ] `mawbShipperExtract.js` — create: extract shipper name from MAWB PDF via `know_companies.json`
- [ ] `AcheminementCard.jsx` — add 4 conditional inputs when `partiel=true`: `shipperName`, `fretValue`, `mawbCurrency`, `qteFacturee`
- [ ] `electron/main.js` — add 4 fields to `SAVED_FIELDS`; auto-populate `shipperName` + `qteFacturee` from scan
- [ ] `index.js` — add `/exchange-rate` endpoint (BAM → frankfurter → OXR fallback)

### Phase 1 — BADR Lot Lookup (Partiel)

- [ ] `badrLotLookup.js` — when `partiel=true` and ≥2 rows: collect all into `partiels[]` array; if <2 rows return `{ waitForMoreLots: true }`

### Phase 2 — BADR DUM Declaration

- [ ] `badrDumNormalPartiel.js` — CREATE: 10-step flow (Entête → Transport → Caution → Préapurement loop → Documents → Demandes → Articles → Print)
- [ ] `electron/main.js` — add 12 new partiel phases to state machine; orchestration path for `partiel=true` LTAs

---

Some LTAs were running BADR finalization again after `Workflow fully complete`. Root cause was a resume path in `monitorPendingPortnetRequests()` that finalized any `badrRef` checkpoint, even when `phase` was already `badr_done`. Fixed by gating the resume call to only run when `state.badrRef && state.phase !== "badr_done"`.

**File changed:** `electron/main.js`

### Fixed 2026-04-23: BADR DEDOUANEMENT menu items hidden after popup closes

`declarerScelles()` was timing out because `a#_205151` (DS MEAD COMBINEE) and `a#_12251` (Déclarer scellés) resolved as hidden in PrimeFaces after the prior download popup closed. Fixed by wrapping the full DEDOUANEMENT → DS MEAD COMBINEE → Déclarer scellés click sequence in a retry loop (max 3 attempts) that calls `badrConn.navigateToAccueil()` on timeout before re-expanding.

**File changed:** `src/badr/badrDsCombineFinalize.js`

### Fixed 2026-04-23: "Nouveau" status after submit → retry full Portnet form fill

After clicking Envoyer, if the consultation row shows status `Nouveau` (draft, not actually sent), the monitoring loop now detects it at attempt > 2 and re-fills the entire Portnet form from scratch using saved `lotInfo` (no BADR re-query). Up to 3 retries; 4th stuck → error state.

**File changed:** `electron/main.js`

### Fixed 2026-04-09: Multi-LTA consultation row collision

When multiple LTAs share the same `portnetRef` (same flight), rows in Portnet consultation
all list the same `Numéro de la DS de référence`. Without anchors, all LTAs were locking onto
the same newest row → wrong `refDsMead` assignments. Fixed via `claimedRowAnchors` in
`electron/main.js` + `excludeCreatedAt` in `getConsultationStatus`.

### Fixed 2026-04-22: Manifest PDF total value wrong (216555 instead of 16555)

Root cause: `renderPageToText` concatenated same-Y items without spaces → footer `2112 16555,04 870` became `211216555,04870` → prefix-split returned `216555`. Fixed by: (1) adding a space between same-Y items in `renderPageToText`; (2) new `extractPageFooterText` function that crops to bottom third of last page using X/Y coordinates and sorts items left→right. `footerText` is now tried first in extraction chain.

**File changed:** `src/utils/manifestPdfExtract.js`

### Fixed 2026-04-22: Editable "Manifest ref LTA" to bypass refMismatch

When manifest PDF has wrong LTA ref, users can now type the correct reference in a new "Manifest ref LTA" input (shown in the mismatch warning area). Once filled, the Lancer button unlocks and the corrected ref is used at every automation step. Persisted to `acheminement.json` as `manifestRef`.

**Files changed:** `src/ui/components/AcheminementCard.jsx`, `electron/main.js`

### Fixed 2026-04-21: Portnet "Contactez-nous" widget blocks Créer button

Portnet added a Click2Connect floating widget inside the form iframe that overlays the `Créer` submit button in `fillCaution`. Fixed by evaluating JS to remove the widget root (`[style*="--verticalGradientStartColor"]` container) from the iframe DOM before clicking `Créer`. Uses `.catch(() => {})` so it's a no-op if the widget isn't present.

**File changed:** `src/portnet/portnetDsCombine.js`

### Fixed 2026-04-22: Manifest PDF total value wrong (216555 instead of 16555)

Root cause: `renderPageToText` concatenated same-Y items without spaces → footer `2112 16555,04 870` became `211216555,04870` → prefix-split returned `216555`. Fixed by: (1) adding a space between same-Y items in `renderPageToText`; (2) new `extractPageFooterText` function that crops to bottom third of last page using X/Y coordinates and sorts items left→right. `footerText` is now tried first in extraction chain.

**File changed:** `src/utils/manifestPdfExtract.js`

### Fixed 2026-04-22: Editable "Manifest ref LTA" to bypass refMismatch

When manifest PDF has wrong LTA ref, users can now type the correct reference in a new "Manifest ref LTA" input (shown in the mismatch warning area). Once filled, the Lancer button unlocks and the corrected ref is used at every automation step. Persisted to `acheminement.json` as `manifestRef`.

**Files changed:** `src/ui/components/AcheminementCard.jsx`, `electron/main.js`

### Fixed 2026-04-21: Portnet "Contactez-nous" widget blocks Créer again

The floating "Contactez-nous" (Click2Connect) widget was again blocking the Créer button in the Portnet caution form. The removal logic in `fillCaution()` is now robust: it removes all matching elements, also by text, and retries up to 3 times if needed.

**File changed:** `src/portnet/portnetDsCombine.js`

### Fixed 2026-04-15: Manifest PDF extraction — leading zero in value + currency source of truth

Two extraction bugs: (1) footer value `13683,15` extracted as `013683.15` — fixed by using `parseInt(valueInt, 10)` instead of raw string slice when stripping prefix digits. (2) header currency (e.g. `MAD`) overrode table rows which all said `USD` — added `extractCurrencyFromTableRows` that counts currency occurrences; table rows dominate the count so they win. Both fixed in `src/utils/manifestPdfExtract.js`.

### Fixed 2026-04-14: Portnet consultation reload crash (batch stops on page timeout)

`_ensureConsultationSortedByCreatedAtDesc` threw when Portnet's iframe was slow to render after reload → crash propagated to batch level → all monitoring stopped. Fixed with two layers: (1) non-throwing `waitFor` in the sort method, (2) try/catch around reload+sort in polling loop. A slow page load now logs a warning and continues to next poll cycle.

### Fixed 2026-04-14: BADR MISE EN DOUANE expand check (ui-state-active)

Checking `#_150` visibility to decide whether to click the MISE EN DOUANE header was unreliable — when already expanded, Playwright could still see `#_150` as invisible and click to collapse it. Now checks `ui-state-active` on the h3 header (the class BADR adds only when truly expanded). Fixed in `badrLotLookup.js` and `badrDsCombineFinalize.js`.

### Fixed 2026-04-13: BADR finalize popup timeout (UI flakiness)

`downloadAutorisationEntree` was waiting 120s for a popup that sometimes never fires on first click due to BADR menu animation not fully settled. Now waits 800ms + `waitFor visible` after menus expand, then retries popup click up to 3×20s. Self-heals on attempt 2 without full automation restart.

### Fixed 2026-04-10: Manifeste compression safe-threshold

Portnet rejected ~1994 KB compressed PDFs. Added `SAFE_BYTES = 1900 KB` in `compressPdfChain.js`—any compressed result > 1900 KB now falls through to first+last page fallback.

### Fixed 2026-04-09: MAWB PDF compression (Ghostscript, free)

MAWB files > 2 MB were not compressed (iLovePDF/Adobe chain is manifeste-only).
Fixed by adding `compressMawbGhostscript` using local GS: /printer → /ebook → /screen
progressive, validates output PDF integrity before accepting. Skip if ≤ 2 MB.

### Fixed 2026-04-09: LTA folders not sorted numerically on scan

`readdirSync` alphabetical order caused "10eme LTA" to appear before "7eme LTA".
Fixed by sorting `acheminements` by `parseInt(id)` before returning in `folder:scan` handler.

### Fixed 2026-04-09: sendLog not writing to log file

All orchestration-layer logs (`sendLog` in `main.js`) were only sent to the renderer UI, never to
`logs/automation-YYYY-MM-DD.log`. Fixed by exporting `write` from `src/utils/logger.js` and routing
`sendLog` through it (file + console + logEmitter → renderer in one call).

---

## Known Incomplete / TODO Items

### 1. Email Notifications — NOT WIRED

**Status:** `nodemailer` is installed. Multiple `[TODO MAIL]` markers exist in `electron/main.js`. Nothing is actually sent.

**Locations in `electron/main.js`:**

- Weight mismatch alert (diff 5–20 kg): `log.info("[TODO MAIL] Send weight mismatch alert...")`
- "Pas encours manifest" (isEmpty from lot lookup): `log.info("[TODO MAIL] ALERT_MAIL...")`

**`badrDsCombineFinalize.js`:**

- After downloading Autorisation d'Entrée PDF: `log.info("Ready to email PDF ... (Mailing feature pending...)")`

**What to implement:**

- Wire `nodemailer` with `config.email.*` credentials
- Send weight mismatch email with: LTA name, BADR weight, user weight, diff
- Send empty manifest alert email with: LTA name, refNumber
- Send Autorisation d'Entrée PDF as attachment after badr_done

---

### 2. `index.js` CLI is Outdated

`index.js` is a CLI orchestrator that was written early in development. It does NOT include:

- Annexe upload (PDF compression + Portnet file upload)
- Scellés filling
- BADR finalize (downloadAutorisationEntree + declarerScelles)
- Checkpoint/resume system

**The canonical full workflow is in `electron/main.js`.**

Decision: Either update `index.js` to match `electron/main.js` flow, or delete it. It is not used in the Electron app.

---

### 3. `manifestPdfExtract copy.js` — Dead File

`src/utils/manifestPdfExtract copy.js` is a leftover copy. Can be deleted safely.

---

### 4. No UI Status for `badr_done`

`mapCheckpointToStatus()` in `electron/main.js` may not have a distinct visual badge for `badr_done` phase. The UI shows the automation state, but `badr_done` should display a clear "Completed" badge.

**Check:** `src/ui/components/StatusBadge.jsx` to confirm `badr_done` is handled.

---

### 5. Portnet Session Disconnect on Long Polls

The consultation page session can disconnect if polling goes long. The current code refreshes the page periodically. If session drops, the polling loop needs to detect re-login and re-authenticate.

**Current behavior:** Page is refreshed ~every 1 min (from `completion.md` notes). Unverified if session expiry is handled gracefully.

---

### 6. BADR Session Reconnect

`badrConnection.js` has a `reconnect()` method, but it is unclear if `electron/main.js` calls it on Portnet-side long waits (when BADR sits idle during Portnet polling, which can take hours).

**Check:** Does `electron/main.js` reconnect BADR before calling `processFinalization()` if BADR was idle during Portnet polling?

---

### 7. Weight Rule: partiel_skip Condition

Current logic: if `isPartiel === true` (rowCount > 1 in lot popup), skip and mark `partiel_skip`.
BUT: `acheminement.partiel` is also a user-editable field on the card UI. Verify that both the BADR-detected partiel (from lot lookup) and the user-set `partiel` flag interact correctly. No double-run risk.

---

### 8. Scellés Validation Before Run

The system enters `scelle1` and `scelle2` from `acheminement.json` directly into BADR without pre-validating that both are non-empty. If a user forgets to enter scellés, BADR finalize will fail mid-run.

**Recommended:** Validate `scelle1` and `scelle2` are non-empty before starting automation, surface error in UI before the run begins.

---

## Priority Order (suggested)

1. **Email notifications** — business need, multiple TODO markers
2. **Scellés pre-validation** — prevent silent failures at finalize step
3. **BADR session idle reconnect** — needed for reliability on long Portnet polls
4. **`badr_done` UI badge** — cosmetic but important for operator confirmation
5. **Delete `manifestPdfExtract copy.js`** — cleanup
6. **Delete or port `index.js`** — cleanup / completeness
