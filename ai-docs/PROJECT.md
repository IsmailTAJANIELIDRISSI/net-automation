# PROJECT.md — Med Africa Logistics Automation

## What This App Does

A Windows desktop Electron app that automates the full Moroccan customs clearance workflow for air freight LTA (Lettre de Transport Aérien) shipments handled by **Med Africa Logistics**. It orchestrates two external systems — **BADR** (Moroccan Customs) and **Portnet** (Morocco's single trade window) — to produce a DS Combinée MEAD declaration per LTA, then finalise scellés on BADR.

---

## Business Workflow (End-to-End)

```
Scan Acheminements/ folder
       ↓
For each LTA folder:
  1. BADR Lot Lookup
     - Navigate MISE EN DOUANE → Lot de dédouanement popup
     - Search by LTA refNumber in date window (configurable retries)
     - Return: declarationRef, sequenceNum, lieuChargement, isPartiel, isEmpty
     ↓
  2. BADR Pré-apurement DS Weight Check
     - Create new déclaration in BADR
     - Navigate to Préapurement DS tab → fill lot fields
     - Read poidsBrut + nombreContenants from result
     ↓
  3. Weight Decision Rules
     - diff > 20 kg  → mark partiel_skip (skip silently, user configured partiel=true)
     - 5 < diff ≤ 20 → mark weight_mismatch (halt, [TODO MAIL] alert)
     - diff ≤ 5 kg   → continue
     ↓
  4. Portnet DS Combinée Form (9+ steps, inside cross-origin iframe)
     - Login (Chromium, manual CAPTCHA, 120s wait)
     - Navigate to /dsCombine/nouvelle-creation
     - Fill: agrément, anticipation, type DS, DS référence, bureau destination,
             pays provenance/destination, date voyage, arrondissement, lieu stockage,
             montant/devise, caution, connaissement + importateur,
             annexe (Manifeste PDF + MAWB PDF, compressed)
     - Click "Envoyer DS MEAD Combinée"
     - Save portnetRef from consultation grid dsReference column
     ↓
  5. Portnet Polling (consultation page)
     - Poll https://cargo.portnet.ma/dsCombine/consultation every 60s→120s→180s
     - Find row where dsReference = portnetRef
     - Read dsCombineStatusDescription: "Envoyée" → keep waiting
     - "Acceptée" → extract refDsMead (e.g. 30100020260001425H) → take last non-zero part (e.g. "1425H")
     - "Rejetée" → mark error, stop
     ↓
  6. BADR Finalize — Déclaration Search + Scellés
     - Navigate MISE EN DOUANE → Services → Recherche par reference → Déclaration (popup)
     - Search by ds serie (extracted from refDsMead)
     - Download Autorisation d'Entrée PDF
     - Declare scellés (scelle1, scelle2) in BADR
     ↓
  7. Mark phase = badr_done → LTA complete
```

---

## State Machine

Stored in `Acheminements/<LTA>/acheminement.json` → `automationState.phase`

| Phase                  | Meaning                                        |
| ---------------------- | ---------------------------------------------- |
| `(none)`               | Never run                                      |
| `badr_checked`         | BADR lot lookup + weight check passed          |
| `portnet_sent_waiting` | DS Combinée submitted, polling for status      |
| `portnet_submitted`    | Accepted by Portnet (refDsMead saved)          |
| `portnet_accepted`     | Alias for portnet_submitted (legacy)           |
| `badr_done`            | BADR scellés declared — fully complete         |
| `weight_mismatch`      | BADR weight diff 5–20kg — halted, needs review |
| `partiel_skip`         | Multiple lots (isPartiel) — skipped by design  |
| `error`                | Unexpected failure                             |

Checkpoint logic in `electron/main.js` → `updateAutomationState(folderPath, patch)` — patches only the fields provided, never full overwrite.

---

## Key Data Entities

### Acheminement (per-LTA state file)

```json
{
  "id": "unique",
  "name": "33eme LTA",
  "folderPath": "C:/Acheminements/33eme LTA",
  "refNumber": "157-54440131",
  "scelle1": "11742905",
  "scelle2": "11742906",
  "nombreContenant": "133",
  "poidTotal": "2415",
  "currency": "MAD",
  "totalValue": "45000",
  "sequenceNumber": "12345",
  "lieuChargement": "IST",
  "partiel": false,
  "manifeste": "Manifeste TK617.pdf",
  "automationState": {
    "phase": "badr_done",
    "portnetRef": "...",
    "updatedAt": "..."
  }
}
```

### LotInfo (returned by badrLotLookup)

```json
{
  "declarationRef": "301-010-2026-XXXXX-X",
  "bureau": "301",
  "regime": "010",
  "annee": "2026",
  "serie": "XXXXX",
  "cle": "X",
  "sequenceNum": "12345",
  "lieuChargement": "IST",
  "lotReference": "123-12345678",
  "isPartiel": false,
  "isEmpty": false,
  "rowCount": 1
}
```

### PoidsInfo (returned by badrPreapurement)

```json
{ "poidsBrut": "2415", "nombreContenants": "133" }
```

### AutomationState

```json
{
  "phase": "portnet_sent_waiting",
  "lotInfo": { ... },
  "badrWeight": "2415",
  "userWeight": "2420",
  "portnetRef": "30100020260003447U",
  "error": null,
  "updatedAt": "2026-03-12T10:00:00.000Z"
}
```

---

## Session Architecture

### Shared Browser Singletons

- `sharedPortnetApp` / `sharedPortnetPage` — one Chromium instance reused across all LTAs in a session. Created by `ensurePortnetSession()` in `electron/main.js`. Never closed until app exits or user explicitly disconnects.
- `sharedBadrConn` — `BadrConnection` singleton. Edge launched with `--remote-debugging-port=9222` and profile at `BADR_PROFILE_DIR`. Connected via `chromium.connectOverCDP()`.

**Critical:** Never delete or wipe `BADR_PROFILE_DIR` — it holds the USB certificate private key trust.

### CAPTCHA Strategy

Portnet requires a visual CAPTCHA on login. The app opens a visible Chromium window, fills username + password, then waits **120 seconds** for the human to solve the CAPTCHA. After that, the session is reused for all LTA runs.

---

## PDF Handling

### Compression Chain (`src/utils/compressPdfChain.js`)

1. iLovePDF account #1 (primary) → extreme compression
2. iLovePDF account #2 (partner) → if #1 quota/auth error
3. iLovePDF account #3 (partner2) → if #2 also fails
4. Adobe PDF Services → if iLovePDF all fail
5. First+Last pages only → `pdf-lib` fallback if all API calls fail

Target: ≤ 2 MB. Cache in `<LTA>/compress/` folder (bypass with `PORTNET_IGNORE_COMPRESS_CACHE=true`).

### Manifest PDF Extraction (`src/utils/manifestPdfExtract.js`)

Reads only first + last page (performance: manifests can be 200+ pages).

- Extracts MAWB ref from "MAWB 157-XXXXXXXX" header
- Extracts metrics from "133Pcs 2415kg Currency:MAD TotalValue:45000" pattern
- `pickManifestPdf()` — finds `Manifeste*.pdf` in LTA folder
- `pickMawbPdf()` — finds `MAWB*.pdf` in LTA folder

---

## Hardcoded Business Constants

| Constant               | Value                   | Location                   |
| ---------------------- | ----------------------- | -------------------------- |
| Bureau                 | 301                     | `config.js` + preapurement |
| Régime                 | 010                     | `config.js` + preapurement |
| Arrondissement         | 373                     | `portnetDsCombine.js`      |
| Lieu de stockage       | "MAG.RAM IMP. NOUASSER" | `portnetDsCombine.js`      |
| Agrément search        | "MED AFRICA LOGISTICS"  | `portnetDsCombine.js`      |
| Importateur RC         | 300035                  | `portnetDsCombine.js`      |
| Caution type           | 1                       | `portnetDsCombine.js`      |
| Caution numeroDecision | 821                     | `portnetDsCombine.js`      |

---

## External Systems

| System               | URL                                               | Auth                           | UI Tech                              |
| -------------------- | ------------------------------------------------- | ------------------------------ | ------------------------------------ |
| BADR                 | `https://badr.douane.gov.ma:40444/badr/`          | USB certificate (Edge profile) | PrimeFaces JSF                       |
| Portnet DS Combinée  | `https://cargo.portnet.ma/`                       | Username + password + CAPTCHA  | React MUI inside cross-origin iframe |
| Portnet Consultation | `https://cargo.portnet.ma/dsCombine/consultation` | (same session)                 | MUI DataGrid                         |
| iLovePDF             | API                                               | publicKey + secretKey          | REST                                 |
| Adobe PDF Services   | API                                               | clientId + clientSecret        | REST                                 |
| Email SMTP           | configurable                                      | SMTP credentials               | nodemailer                           |

---

## Polling Logic

Consultation page at `https://cargo.portnet.ma/dsCombine/consultation`:

- Find row where `data-field="dsReference"` matches saved portnetRef
- Read `data-field="dsCombineStatusDescription"`: "Envoyée" / "Acceptée" / "Rejetée"
- On "Acceptée": extract `data-field="refDsMead"` aria-label (e.g. "30100020260001425H")
  → take digits after leading zeros strip: "1425H" → pass to BADR finalize
- Backoff intervals: attempt 1-3 → 60s, attempt 4-6 → 120s, attempt 7+ → 180s
- Page refreshed every ~1 min to keep session alive

---

## Folder Structure (Runtime Data)

```
Acheminements/
  <LTA name>/
    acheminement.json          ← state file
    Manifeste TK617.pdf        ← manifest (first+last extracted)
    MAWB 157-XXXXXXXX.pdf      ← air waybill
    compress/
      portnet_annex_*.pdf      ← cached compressed PDFs
```
