# PROGRESS.md — Change Log

_Append-only. Each entry = problem solved + decision made + files changed._
_Format: `## YYYY-MM-DD — <title>`_

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
