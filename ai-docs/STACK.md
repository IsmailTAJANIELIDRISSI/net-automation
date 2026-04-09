# STACK.md — Technology Stack & Conventions

## Runtime & Platform

| Layer           | Technology           | Version          |
| --------------- | -------------------- | ---------------- |
| Runtime         | Node.js              | 18+              |
| Desktop shell   | Electron             | 33.x             |
| React UI        | Vite + React         | Vite 6, React 18 |
| CSS             | Tailwind CSS         | 3.x              |
| Automation      | Playwright           | 1.58             |
| BADR browser    | Microsoft Edge (CDP) | system install   |
| Portnet browser | Playwright Chromium  | bundled          |

---

## NPM Dependencies (Key)

| Package                       | Purpose                                                 |
| ----------------------------- | ------------------------------------------------------- |
| `playwright`                  | Browser automation (Chromium for Portnet, CDP for BADR) |
| `electron`                    | Desktop app shell, IPC, file system access              |
| `electron-builder`            | Packaging/distribution                                  |
| `react`, `react-dom`          | UI renderer                                             |
| `vite`                        | Dev server + build tool                                 |
| `tailwindcss`                 | Utility CSS                                             |
| `pdf-lib`                     | First+last page PDF extraction fallback                 |
| `pdf-parse`                   | Extract text from PDF pages                             |
| `@adobe/pdfservices-node-sdk` | Adobe PDF compression (fallback #2)                     |
| `@ilovepdf/ilovepdf-nodejs`   | iLovePDF compression (primary)                          |
| `adm-zip`                     | ZIP handling for iLovePDF downloads                     |
| `nodemailer`                  | Email alerts (SMTP) — partially implemented             |
| `dotenv`                      | Load `.env` config                                      |
| `electron-reload`             | Hot-reload in dev                                       |

---

## Environment Variables (`.env`)

All consumed via `src/config/config.js`. Never hardcode secrets — always reference `config.*`.

### BADR

| Variable                     | Description                                                         |
| ---------------------------- | ------------------------------------------------------------------- |
| `BADR_PROFILE_DIR`           | Edge user profile directory holding USB cert trust — **never wipe** |
| `BADR_EDGE_PATH`             | Absolute path to `msedge.exe`                                       |
| `BADR_URL`                   | Base URL (default: `https://badr.douane.gov.ma:40444/badr/`)        |
| `BADR_USER`                  | BADR username                                                       |
| `BADR_PASS`                  | BADR password                                                       |
| `BADR_SEARCH_WINDOW_DAYS`    | Days to search back for lot (default: 7)                            |
| `BADR_SEARCH_RETRY_ATTEMPTS` | Retry attempts with expanding window (default: 3)                   |

### Portnet

| Variable                               | Description                                     |
| -------------------------------------- | ----------------------------------------------- |
| `PORTNET_USER`                         | Portnet username (GN41473)                      |
| `PORTNET_PASS`                         | Portnet password                                |
| `PORTNET_URL`                          | Base URL (default: `https://cargo.portnet.ma/`) |
| `PORTNET_STOP_AFTER_ANNEX_COMPRESSION` | Debug flag: stop before uploading annexe        |
| `PORTNET_IGNORE_COMPRESS_CACHE`        | Force recompress even if cached                 |

### PDF Compression

| Variable                    | Description                         |
| --------------------------- | ----------------------------------- |
| `ILOVE_PUBLIC_KEY`          | iLovePDF primary account public key |
| `ILOVE_SECRET_KEY`          | iLovePDF primary account secret key |
| `ILOVE_PARTNER_PUBLIC_KEY`  | iLovePDF partner account #2         |
| `ILOVE_PARTNER_SECRET_KEY`  | iLovePDF partner account #2 secret  |
| `ILOVE_PARTNER2_PUBLIC_KEY` | iLovePDF partner account #3         |
| `ILOVE_PARTNER2_SECRET_KEY` | iLovePDF partner account #3 secret  |
| `ADOBE_CLIENT_ID`           | Adobe PDF Services client ID        |
| `ADOBE_CLIENT_SECRET`       | Adobe PDF Services client secret    |

### Email

| Variable     | Description       |
| ------------ | ----------------- |
| `EMAIL_HOST` | SMTP host         |
| `EMAIL_PORT` | SMTP port         |
| `EMAIL_USER` | SMTP username     |
| `EMAIL_PASS` | SMTP password     |
| `EMAIL_FROM` | From address      |
| `EMAIL_TO`   | Recipient address |

### Misc

| Variable   | Description                                     |
| ---------- | ----------------------------------------------- |
| `HEADLESS` | Run Portnet headless (always false in practice) |
| `SLOW_MO`  | Playwright slowMo ms                            |
| `TIMEOUT`  | Default Playwright timeout ms                   |
| `LOGS_DIR` | Log output directory (default: `logs/`)         |

---

## Folder Structure

```
portnet-automation-playwright/
├── electron/
│   ├── main.js          ← Electron main process, all IPC handlers, automation orchestration
│   └── preload.js       ← contextBridge — exposes window.api to React renderer
├── src/
│   ├── config/
│   │   └── config.js    ← Single source for all env vars
│   ├── badr/
│   │   ├── badrConnection.js        ← Launch Edge + CDP connect + BADR login
│   │   ├── badrLotLookup.js         ← BADR lot popup search
│   │   ├── badrPreapurement.js      ← BADR weight/poids check via DS form
│   │   └── badrDsCombineFinalize.js ← Download Autorisation d'Entrée + declare scellés
│   ├── portnet/
│   │   ├── portnetLogin.js    ← Launch Chromium + CAPTCHA wait + return page
│   │   └── portnetDsCombine.js ← All 9+ steps of DS Combinée form
│   ├── utils/
│   │   ├── logger.js              ← Structured logger, EventEmitter, file+IPC output
│   │   ├── compressPdfChain.js    ← iLovePDF × 3 → Adobe → first+last fallback
│   │   ├── manifestPdfExtract.js  ← Extract MAWB/metrics from manifest PDF
│   │   └── manifestPdfExtract copy.js ← Dead file, can be deleted
│   └── ui/
│       ├── App.jsx         ← Root React component, folder scan, IPC subscriptions
│       ├── index.css       ← Tailwind base + custom styles
│       ├── index.html      ← Electron renderer HTML entry
│       ├── main.jsx        ← React DOM root
│       └── components/
│           ├── AcheminementCard.jsx ← Per-LTA card UI
│           ├── Header.jsx           ← App header
│           ├── LogPanel.jsx         ← Scrolling log output panel
│           └── StatusBadge.jsx      ← Phase → colored badge
├── index.js             ← CLI orchestrator (outdated vs Electron flow)
├── login-portnet.js     ← Standalone Portnet login script
├── ai-docs/             ← THIS FOLDER — agent memory
├── Acheminements/       ← Runtime data: LTA folders + acheminement.json files
├── logs/                ← Daily log files: automation-YYYY-MM-DD.log
├── scripts/             ← Dev/debug scripts (compress tests, etc.)
├── docs/                ← Analysis docs (PDF extraction, polling analysis)
├── .env                 ← Secrets (never commit)
├── package.json
└── vite.config.js       ← Vite config for React UI build
```

---

## Code Conventions

### Logger Pattern

```js
const { createLogger } = require("../utils/logger");
const log = createLogger("ModuleName");
log.info("message");
log.warn("message");
log.error("message");
```

Logs go to: console + `logs/automation-YYYY-MM-DD.log` + `logEmitter.emit('log', entry)` (forwarded to Electron renderer via IPC `log-message` channel).

### Class Pattern (BADR/Portnet modules)

```js
class BadrConnection {
  constructor() { this.browser = null; this.page = null; }
  async connect() { ... }
  async disconnect() { ... }
}
module.exports = BadrConnection;
```

### IPC Channel Naming

Defined in `electron/preload.js` via `contextBridge.exposeInMainWorld('api', {...})`.

- `api.selectFolder()` → `ipcMain.handle('select-folder', ...)`
- `api.scanFolder(path)` → `ipcMain.handle('scan-folder', ...)`
- `api.runAutomation(ach)` → `ipcMain.handle('run-automation', ...)`
- `api.runAllAutomation(achs)` → `ipcMain.handle('run-all-automation', ...)`
- `api.saveAcheminement(ach)` → `ipcMain.handle('save-acheminement', ...)`
- `api.onLog(cb)` → `ipcRenderer.on('log-message', cb)`
- `api.onProgress(cb)` → `ipcRenderer.on('progress-update', cb)`
- `api.openPath(path)` → `ipcMain.handle('open-path', ...)`

### MUI Interaction Helpers (portnetDsCombine.js)

- `_muiSelect(name, valueText)` — opens MUI select by id, clicks option
- `_muiSelectByText(label, text)` — find MUI select by visible label text
- `_getListbox()` — waits for MUI listbox to appear
- `_forceClose()` — clicks outside to close open dropdown
- All Portnet interactions go through `this.frame` (FrameLocator), never `this.page`

### BADR Input Strategy

Use `pressSequentially()` not `fill()` for PrimeFaces autocomplete inputs. PrimeFaces relies on keyboard events to trigger AJAX suggestions.

### normalizeLotReference

Strips leading zeros from lot reference: `"003-00012345"` → `"3-12345"`. Used internally when matching lot data.

---

## Build & Run Commands

```bash
# Development (Electron + Vite hot reload)
npm run dev

# Build React UI
npm run build

# Package Electron app
npm run dist

# CLI automation (outdated)
node index.js --lotRef=157-54440131

# Electron app entry
npm start
```

---

## Key Config Values (Fixed/Hardcoded)

These are NOT in `.env` — they are hardcoded business constants in source:

| Constant               | Value                   | File                                 |
| ---------------------- | ----------------------- | ------------------------------------ |
| Bureau destination     | 301                     | `portnetDsCombine.js`, `config.js`   |
| Régime                 | 010                     | `config.js`, `badrPreapurement.js`   |
| Arrondissement         | 373                     | `portnetDsCombine.js`                |
| Lieu de stockage       | "MAG.RAM IMP. NOUASSER" | `portnetDsCombine.js`                |
| Agrément search text   | "MED AFRICA LOGISTICS"  | `portnetDsCombine.js`                |
| Importateur RC         | 300035                  | `portnetDsCombine.js`                |
| Caution type           | 1                       | `portnetDsCombine.js`                |
| Caution numeroDecision | 821                     | `portnetDsCombine.js`                |
| Max annex size         | 2 MB                    | `compressPdfChain.js`                |
| CAPTCHA wait timeout   | 120s                    | `portnetLogin.js`                    |
| Portnet poll backoff   | 60/120/180s             | `electron/main.js` getPollIntervalMs |
