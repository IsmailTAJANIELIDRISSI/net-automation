# TASKS.md — Current State & Next Steps

## Current State

The core automation flow is **fully implemented and working in production**:

- BADR lot lookup ✅
- BADR pré-apurement weight check ✅
- Portnet DS Combinée form (all 9 steps) ✅
- PDF compression chain (iLovePDF → Adobe → fallback) ✅
- Portnet polling for Acceptée/Rejetée ✅
- BADR finalize (scellés declaration) ✅
- Electron UI with per-LTA cards and live log panel ✅
- Checkpoint/resume system ✅

### Fixed 2026-04-09: Multi-LTA consultation row collision

When multiple LTAs share the same `portnetRef` (same flight), rows in Portnet consultation
all list the same `Numéro de la DS de référence`. Without anchors, all LTAs were locking onto
the same newest row → wrong `refDsMead` assignments. Fixed via `claimedRowAnchors` in
`electron/main.js` + `excludeCreatedAt` in `getConsultationStatus`.

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
