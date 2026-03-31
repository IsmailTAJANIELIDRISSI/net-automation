"use strict";
/**
 * PortnetDsCombine – fills the "Nouvelle DS Combinée" form on Portnet.
 *
 * IMPORTANT: cargo.portnet.ma embeds the actual form inside a cross-origin
 * <iframe src="https://manifeste-prod.portnet.ma/combineEnteteMead?token=...">
 * All MUI selectors must target that iframe, not the outer page.
 *
 * Flow:
 *  1. Navigate to /dsCombine/nouvelle-creation → wait for iframe
 *  2. Select Numéro d'agrément → search dialog → pick "MED AFRICA LOGISTICS"
 *  3. Select Anticipation = Non
 *  4. Select Type DS référence = Maritime / Aérien
 *  5. Open DS référence search dialog → enter séquence + type → Rechercher
 *  6. Paginate to last page → click last row Sélectionner
 *  7. Select Arrondissement = TELECONTROLE IMPORT FRET
 *  8. Select Lieu de stockage = MAG.RAM IMP. NOUASSER
 *  9. Fill Montant + Devise (if provided)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const config = require("../config/config");
const { createLogger } = require("../utils/logger");

const log = createLogger("PortnetDsCombine");
const execFileAsync = promisify(execFile);

// Temporary debug mode: keep compressed files in each LTA folder and stop
// the workflow right after compression (before Annexe upload).
const STOP_AFTER_ANNEX_COMPRESSION =
  String(
    process.env.PORTNET_STOP_AFTER_ANNEX_COMPRESSION || "true",
  ).toLowerCase() === "true";

const GS_TIMEOUT_MS = Math.max(
  Number(process.env.PORTNET_GS_TIMEOUT_MS || 180000),
  180000,
);
const GS_TIMEOUT_PER_MB_MS = Math.max(
  Number(process.env.PORTNET_GS_TIMEOUT_PER_MB_MS || 12000),
  5000,
);
const GS_PROFILE = String(process.env.PORTNET_GS_PROFILE || "fast")
  .trim()
  .toLowerCase();
const GS_LARGE_FILE_MB = Math.max(
  Number(process.env.PORTNET_GS_LARGE_FILE_MB || 10),
  5,
);

const TIMEOUT = config.timeout;
const FORM_CFG = config.portnet.form;

// ISO currency code → Portnet display label (from the devise dropdown HTML)
const DEVISE_MAP = {
  USD: "DOLLAR U.S.A.",
  EUR: "Euros",
  MAD: "DIRHAM MAROCAIN",
  GBP: "LIVRE STERLING",
  CHF: "FRANC SUISSE",
  CAD: "DOLLAR CANADIEN",
  JPY: "YENS JAPONAIS",
  AED: "DIRHAM E.A.U.",
  SAR: "RIYAL SAOUDIEN",
  QAR: "RIYAL QATARI",
  KWD: "DINAR KOWEITIEN",
  BHD: "DINAR BAHREINI",
  TND: "DINAR TUNISIEN",
  DZD: "DINAR ALGERIEN",
  CNY: "Yuan Chinois",
  INR: "Roupie Indienne",
  RUB: "Rouble Russe",
  BRL: "Real Brésilien",
  ZAR: "Rand Sud-Africain",
  AUD: "Dollar Australien",
  TRY: "Livre Turque",
  EGP: "Livre Egyptienne",
  JOD: "Dinar Jordanien",
};

class PortnetDsCombine {
  /**
   * @param {import('playwright').Page} page – authenticated Portnet cargo page
   */
  constructor(page) {
    this.page = page;
    this.frame = null; // set by navigate()
  }

  _normalizeLotReference(refNumber) {
    const ref = String(refNumber || "").trim();
    const match = ref.match(/^(0+)(\d+)(-.+)$/);

    if (!match) return ref;

    const normalizedPrefix = String(parseInt(match[2], 10));
    return `${normalizedPrefix}${match[3]}`;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Resolve the exact listbox opened by a MUI combobox.
   * Uses the combobox's own aria-controls attribute so we never
   * accidentally target a stale/wrong listbox.
   */
  async _getListbox(comboboxId) {
    const f = this.frame;
    const combobox = f.locator(`#${comboboxId}`);
    // aria-controls points to the id of the ul[role="listbox"]
    const listboxId = await combobox.getAttribute("aria-controls");
    if (listboxId) {
      // IDs like ":rd:" contain colons – must use [id="..."] not #
      return f.locator(`ul[id="${listboxId}"]`);
    }
    // Fallback: last visible listbox in the frame
    return f.locator('ul[role="listbox"]').last();
  }

  /**
   * After clicking an option, ensure the dropdown actually closes.
   * If it's still open after 1.5 s, press Escape ON the combobox element inside
   * the iframe – this dispatches to the correct iframe context where MUI listens.
   */
  async _forceClose(comboboxId, listbox) {
    const closed = await listbox
      .waitFor({ state: "hidden", timeout: 1500 })
      .then(() => true)
      .catch(() => false);
    if (!closed) {
      // Target Escape to the combobox inside the frame (not page keyboard)
      await this.frame.locator(`#${comboboxId}`).press("Escape");
      await listbox.waitFor({ state: "hidden", timeout: 2000 }).catch(() => {});
    }
    await this.page.waitForTimeout(200);
  }

  /** Click a MUI Select then pick by data-value – operates on this.frame */
  async _muiSelect(comboboxId, dataValue) {
    const f = this.frame;
    await f.locator(`#${comboboxId}`).click();
    const listbox = await this._getListbox(comboboxId);
    await listbox.waitFor({ state: "visible", timeout: 8000 });
    await listbox.locator(`li[data-value="${dataValue}"]`).click();
    await this._forceClose(comboboxId, listbox);
  }

  /** Click a MUI Select then pick by visible text – operates on this.frame */
  async _muiSelectByText(comboboxId, text) {
    const f = this.frame;
    await f.locator(`#${comboboxId}`).click();
    const listbox = await this._getListbox(comboboxId);
    await listbox.waitFor({ state: "visible", timeout: 8000 });
    await listbox.locator(`li[role="option"]:has-text("${text}")`).click();
    await this._forceClose(comboboxId, listbox);
  }

  /**
   * Generic helper for readonly search-icon inputs that open a Code/Description dialog.
   * Clicks the search icon, fills the Code field, clicks Rechercher, picks first result.
   */
  async _searchDialogSelect(labelText, codeValue) {
    const f = this.frame;
    await this._clickSearchIcon(labelText);
    const dialog = f.locator('div[role="dialog"]');
    await dialog.waitFor({ timeout: 10000 });
    // Fill the Code input (first text input in the dialog)
    await dialog.locator('input[type="text"]').first().fill(codeValue);
    // Click Rechercher
    await dialog.locator('button:has-text("Rechercher")').click();
    await this.page.waitForTimeout(1000);
    // Wait for and click the Choisir button on the first result row
    const choisirBtn = dialog
      .locator('div[aria-label="Choisir"] button')
      .first();
    await choisirBtn.waitFor({ timeout: 8000 });
    await choisirBtn.click();
    await this.page.waitForTimeout(800);
    log.info(`"${labelText}" selected with code "${codeValue}"`);
  }

  /** Click the search icon button inside a MUI control – operates on this.frame */
  async _clickSearchIcon(labelText) {
    const f = this.frame;
    const formControl = f
      .locator("div.MuiFormControl-root")
      .filter({ hasText: labelText });
    await formControl.locator('svg[data-testid="SearchIcon"]').click();
    log.info(`Clicked search icon for "${labelText}"`);
  }

  // ── Step 1: Navigate ───────────────────────────────────────────────────────

  async navigate() {
    log.info("Navigating to DS Combinée creation page…");
    await this.page.goto(
      `${config.portnet.cargoUrl}/dsCombine/nouvelle-creation`,
      { waitUntil: "domcontentloaded", timeout: TIMEOUT },
    );

    // The real form is inside an iframe (manifeste-prod.portnet.ma/combineEnteteMead)
    const iframeLoc = this.page.locator("main iframe");
    await iframeLoc.waitFor({ timeout: TIMEOUT });
    this.frame = this.page.frameLocator("main iframe");

    // Wait for the React MUI form to mount inside the iframe
    await this.frame
      .locator("#mui-component-select-declarationAnticipation")
      .waitFor({ timeout: TIMEOUT });

    log.info("DS Combinée creation page (iframe) loaded");
  }

  // ── Step 2: Numéro d'agrément ──────────────────────────────────────────────

  async selectAgrement() {
    const f = this.frame;
    log.info("Selecting Numéro d'agrément…");

    await this._clickSearchIcon("Numero d'agrement");

    // Wait for dialog inside the iframe
    await f.locator('div[role="dialog"]').waitFor({ timeout: 10000 });
    log.info("Agrément dialog opened");

    // Fill Description field
    const dialogDescLabel = f.locator(
      'div[role="dialog"] label:has-text("Description")',
    );
    const forAttr = await dialogDescLabel.getAttribute("for").catch(() => null);
    const descInput = forAttr
      ? f.locator(`[id="${forAttr}"]`)
      : f.locator('div[role="dialog"] input[type="text"]').nth(1);

    await descInput.fill(config.portnet.agrement.searchDescription);
    log.info(
      `Description set to "${config.portnet.agrement.searchDescription}"`,
    );

    await f.locator('div[role="dialog"] button:has-text("Rechercher")').click();
    await this.page.waitForTimeout(1500);

    await f
      .locator('div[role="dialog"] div[aria-label="Choisir"] button')
      .first()
      .click();
    await this.page.waitForTimeout(800);
    log.info("Agrément selected");
  }

  // ── Step 3: Anticipation = Non ─────────────────────────────────────────────

  async selectAnticipationNon() {
    log.info("Setting Anticipation = Non…");
    await this._muiSelect(
      "mui-component-select-declarationAnticipation",
      FORM_CFG.anticipation,
    );
  }

  // ── Step 4: Type DS référence ──────────────────────────────────────────────

  async selectTypeDSReference() {
    log.info("Setting Type DS référence…");
    await this._muiSelect(
      "mui-component-select-typeDSReference",
      FORM_CFG.typeDSReference,
    );
  }

  // ── Step 5–6: DS de référence search ──────────────────────────────────────

  async searchAndSelectDSReference(sequenceNum) {
    const f = this.frame;
    const sequenceDigits = String(sequenceNum || "")
      .split(/[\s-]+/)[0]
      .replace(/\D/g, "");
    const sequenceForSearch = sequenceDigits.padStart(7, "0");

    log.info(`Searching DS de référence for séquence ${sequenceForSearch}…`);

    const dsSearchBtn = f.locator(
      'div[aria-label="Rechercher"] button[type="button"]',
    );
    await dsSearchBtn.first().click();

    // Scope everything to the dialog from here on
    const dialog = f.locator('div[role="dialog"]');
    await dialog.locator('input[name="sequence"]').waitFor({ timeout: 10000 });
    log.info("DS référence search dialog opened");

    await dialog.locator('input[name="sequence"]').fill(sequenceForSearch);
    await this._muiSelect("mui-component-select-typeDsRef", FORM_CFG.typeDsRef);

    await dialog.locator('button:has-text("Rechercher")').last().click();

    // Wait for at least one result row to appear
    await dialog
      .locator(".MuiDataGrid-row")
      .first()
      .waitFor({ timeout: 10000 });
    await this.page.waitForTimeout(500);

    // Paginate to last page only if the button is enabled (multiple pages exist)
    const lastPageBtn = dialog.locator('button[aria-label="Go to last page"]');
    const isDisabled = await lastPageBtn.isDisabled().catch(() => true);
    if (!isDisabled) {
      await lastPageBtn.click();
      // Wait for the last-visible row to update after pagination
      await this.page.waitForTimeout(1000);
      log.info("Navigated to last page of DS results");
    } else {
      log.info("Single page – already on last page");
    }

    // Click Sélectionner on the last visible row in the dialog
    const lastRowSelectBtn = dialog.locator(
      '.MuiDataGrid-row--lastVisible div[aria-label="Sélectionner"] button',
    );
    await lastRowSelectBtn.waitFor({ timeout: 10000 });
    await lastRowSelectBtn.click();
    await this.page.waitForTimeout(1000);
    log.info("DS référence row selected");
  }

  // ── Step: Bureau de destination (dialog lookup) ────────────────────────────

  async selectBureauDestination() {
    log.info("Selecting Bureau de destination (code 301)…");
    await this._searchDialogSelect("Bureau de destination", "301");
  }

  // ── Step: Avec moyen de transport = Non ───────────────────────────────────

  async selectAvecMoyenTransportNon() {
    log.info("Setting Avec moyen de transport = Non…");
    await this._muiSelect("mui-component-select-withTransport", "n");
  }

  // ── Step: Pays de provenance = CN (Chine) ─────────────────────────────────

  async selectPaysProvenance() {
    log.info("Selecting Pays de provenance (CN – Chine)…");
    await this._searchDialogSelect("Pays de provenance", "CN");
  }

  // ── Step: Pays de destination = MA (Maroc) ────────────────────────────────

  async selectPaysDestination() {
    log.info("Selecting Pays de destination (MA – Maroc)…");
    await this._searchDialogSelect("Pays de destination", "MA");
  }

  // ── Step: Date Voyage = today ──────────────────────────────────────────────

  async fillDateVoyage() {
    const f = this.frame;
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, "0");
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const yyyy = today.getFullYear();
    const dateStr = `${dd}/${mm}/${yyyy}`;
    log.info(`Filling Date Voyage = ${dateStr}`);
    const dateInput = f.locator('input[name="dateVoyage"]');
    await dateInput.fill(dateStr);
    await dateInput.press("Tab"); // trigger React onChange
  }

  // ── Step 7: Arrondissement ─────────────────────────────────────────────────

  async selectArrondissement() {
    log.info("Selecting Arrondissement…");
    await this._muiSelect(
      "mui-component-select-idCombineArrondissement",
      FORM_CFG.arrondissement,
    );
  }

  // ── Step 8: Lieu de stockage ───────────────────────────────────────────────

  async selectLieuStockage() {
    log.info(`Selecting Lieu de stockage = "${FORM_CFG.lieuStockage}"…`);
    await this._muiSelectByText(
      "mui-component-select-idLieuStockage",
      FORM_CFG.lieuStockage,
    );
  }

  // ── Step 9: Montant + Devise ───────────────────────────────────────────────

  async fillMontant(montant, deviseId) {
    const f = this.frame;
    if (montant !== undefined && montant !== null && montant !== "") {
      log.info(`Filling Montant = ${montant}`);
      await f.locator('input[name="montant"]').fill(String(montant));
    }
    if (deviseId) {
      // Map ISO code (e.g. "USD") to Portnet display label (e.g. "DOLLAR U.S.A.")
      const deviseLabel = DEVISE_MAP[deviseId.toUpperCase()] || deviseId;
      log.info(`Selecting Devise = ${deviseId} → "${deviseLabel}"`);
      await this._muiSelectByText("mui-component-select-deviseId", deviseLabel);
    }
  }

  // ── Step: Caution ─────────────────────────────────────────────────────────

  async fillCaution() {
    const f = this.frame;
    log.info("Filling Caution form…");

    // Type de caution = Sur engagement personnel (data-value="1")
    await this._muiSelect("mui-component-select-idCombineTypeCaution", "1");

    // Wait for Numéro de décision options to populate
    await this.page.waitForTimeout(1000);

    // Numéro de décision = S2021000002 (data-value="821")
    await this._muiSelect("mui-component-select-numeroDecisionId", "821");
    await this.page.waitForTimeout(500);

    // Click Créer (submit)
    await f.locator('button[type="submit"]:has-text("Créer")').click();
    log.info("Caution Créer clicked – waiting for Connaissement form…");

    // Wait for Connaissement section (note: typo in app HTML = "Connaisssement")
    await f
      .locator('h4:has-text("Connaisssement"), h4:has-text("Connaissement")')
      .first()
      .waitFor({ state: "visible", timeout: 20000 });
    log.info("Connaissement form now visible");
  }

  // ── Step: Connaissement ────────────────────────────────────────────────────

  async fillConnaissement(refNumber, airportValue) {
    const f = this.frame;
    const normalizedRefNumber = this._normalizeLotReference(refNumber);
    log.info(
      `Filling Connaissement: ref=${normalizedRefNumber}, lieu="${airportValue}"…`,
    );

    const refNoDash = normalizedRefNumber.replace(/-/g, ""); // e.g. "60752839835"

    // 1. Référence du lot dans la DS de réference
    await f
      .locator('input[name="referenceLotDsRef"]')
      .fill(normalizedRefNumber);

    // 2. Référence (without dash)
    await f.locator('input[name="reference"]').fill(refNoDash);

    // 3. Lieu de chargement (readonly field – open search dialog)
    await f
      .locator(".MuiFormControl-root")
      .filter({ has: f.locator('label:has-text("Lieu de chargement")') })
      .first()
      .locator('[data-testid="SearchIcon"]')
      .click();

    {
      const dialog = f.locator('div[role="dialog"]');
      await dialog
        .locator('h2:has-text("Recherche compagnie")')
        .waitFor({ timeout: 8000 });

      // Fill Description with the auto-filled airport name from Entête
      await dialog
        .locator(
          '.MuiFormControl-root:has(label:has-text("Description")) input',
        )
        .fill(airportValue);
      await dialog.locator('button:has-text("Rechercher")').last().click();

      // Wait for result row then select
      await dialog
        .locator(".MuiDataGrid-row")
        .first()
        .waitFor({ timeout: 10000 });
      await dialog.locator('div[aria-label="Choisir"] button').first().click();
      log.info(`Lieu de chargement selected: "${airportValue}"`);
    }
    await this.page.waitForTimeout(500);

    // 4. Date de chargement = today
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, "0");
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const yyyy = today.getFullYear();
    const dateStr = `${dd}/${mm}/${yyyy}`;
    const dateInput = f.locator('input[name="dateChargement"]');
    await dateInput.fill(dateStr);
    await dateInput.press("Tab");
    log.info(`Date de chargement = ${dateStr}`);

    // 5. Ligne dépoté = 1
    await f.locator('input[name="ligneDepotee"]').fill("1");

    // 6. Importateur (readonly field – open search dialog)
    await f
      .locator(".MuiFormControl-root")
      .filter({ has: f.locator('label:has-text("Importateur")') })
      .first()
      .locator('[data-testid="SearchIcon"]')
      .click();

    {
      const dialog = f.locator('div[role="dialog"]');
      await dialog
        .locator('h2:has-text("Recherche d")')
        .waitFor({ timeout: 8000 });

      // Fill Numéro RC with Med Africa Logistics constant value
      await dialog.locator('input[name="numeroRc"]').fill("300035");
      await dialog.locator('button:has-text("Rechercher")').last().click();

      // Wait for result row then select
      await dialog
        .locator(".MuiDataGrid-row")
        .first()
        .waitFor({ timeout: 10000 });
      await dialog.locator('div[aria-label="Choisir"] button').first().click();
      log.info("Importateur (MED AFRICA LOGISTICS) selected");
    }
    await this.page.waitForTimeout(500);

    // 7. Click Ajouter scoped to the Connaissement section to avoid clicking
    //    the Ajouter of Annexe or Demandes diverses sections below.
    const connSection = f
      .locator("h4")
      .filter({ hasText: /^Connaisssement$/ })
      .locator('xpath=ancestor::div[contains(@class,"MuiPaper-root")][1]');
    await connSection.locator('button:has-text("Ajouter")').first().click();
    log.info("Connaissement Ajouter clicked – row added to grid");
  }

  // ── PDF compression helper ────────────────────────────────────────────────
  _isLikelyValidPdf(filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size < 32) return false;

      const fd = fs.openSync(filePath, "r");
      try {
        const head = Buffer.alloc(8);
        fs.readSync(fd, head, 0, head.length, 0);
        const headText = head.toString("latin1");
        if (!headText.startsWith("%PDF-")) return false;

        const tailLen = Math.min(4096, stat.size);
        const tail = Buffer.alloc(tailLen);
        fs.readSync(fd, tail, 0, tail.length, stat.size - tailLen);
        const tailText = tail.toString("latin1");

        return tailText.includes("%%EOF");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  _resolveGhostscriptExecutables() {
    const envPath = String(process.env.PORTNET_GS_PATH || "").trim();
    const candidates = [];

    if (envPath) candidates.push(envPath);

    if (process.platform === "win32") {
      const pf64 =
        process.env["ProgramW6432"] ||
        process.env["ProgramFiles"] ||
        "C:\\Program Files";
      const pf32 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
      const known = [
        path.join(pf64, "gs", "gs10.05.1", "bin", "gswin64c.exe"),
        path.join(pf64, "gs", "gs10.04.0", "bin", "gswin64c.exe"),
        path.join(pf64, "gs", "gs10.03.1", "bin", "gswin64c.exe"),
        path.join(pf64, "gs", "gs10.03.0", "bin", "gswin64c.exe"),
        path.join(pf64, "gs", "gs10.02.1", "bin", "gswin64c.exe"),
        path.join(pf64, "gs", "gs10.01.2", "bin", "gswin64c.exe"),
        path.join(pf64, "gs", "gs10.01.1", "bin", "gswin64c.exe"),
        path.join(pf64, "gs", "gs10.01.0", "bin", "gswin64c.exe"),
        path.join(pf64, "gs", "gs10.00.0", "bin", "gswin64c.exe"),
        path.join(pf32, "gs", "gs10.05.1", "bin", "gswin32c.exe"),
      ];
      for (const p of known) {
        if (fs.existsSync(p)) candidates.push(p);
      }
    }

    candidates.push("gswin64c", "gswin32c", "gs");

    return [...new Set(candidates)];
  }

  /**
   * Compress a PDF to <= 2 MB.
   * Primary: iLovePDF API (fast and stable for large scanned files).
   * Fallback: local Ghostscript with explicit downsampling flags.
   */
  async _compressPdfIfNeeded(filePath) {
    const MAX_BYTES = 2 * 1024 * 1024; // 2 MB
    const sizeBytes = fs.statSync(filePath).size;
    if (sizeBytes <= MAX_BYTES) return filePath;

    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
    log.info(
      `PDF compress: "${path.basename(filePath)}" is ${sizeMB} MB – compressing…`,
    );

    const ilovePublic = String(process.env.ILOVEPDF_PUBLIC_KEY || "").trim();
    const iloveSecret = String(process.env.ILOVEPDF_SECRET_KEY || "").trim();

    if (ilovePublic && iloveSecret) {
      try {
        const iloveOutPath = await this._compressViaIlovepdf(
          filePath,
          ilovePublic,
          iloveSecret,
        );
        if (iloveOutPath && fs.existsSync(iloveOutPath)) {
          const outMB = (fs.statSync(iloveOutPath).size / (1024 * 1024)).toFixed(
            1,
          );
          log.info(
            `PDF compress (iLovePDF): ✓ compressed to ${outMB} MB → "${iloveOutPath}"`,
          );
          return iloveOutPath;
        }
      } catch (err) {
        log.warn(
          `PDF compress (iLovePDF) failed: ${err?.message || "unknown error"} – fallback to Ghostscript`,
        );
      }
    } else {
      log.info(
        "PDF compress: ILOVEPDF keys not configured – using Ghostscript fallback",
      );
    }

    return this._compressViaGhostscript(filePath, sizeBytes, MAX_BYTES);
  }

  async _compressViaIlovepdf(filePath, publicKey, secretKey) {
    const ILovePDFApi = require("@ilovepdf/ilovepdf-nodejs");
    const ILovePDFFile = require("@ilovepdf/ilovepdf-nodejs/ILovePDFFile");

    const api = new ILovePDFApi(publicKey, secretKey);
    const task = api.newTask("compress");

    await task.start();
    await task.addFile(new ILovePDFFile(filePath));
    await task.process({ compression_level: "extreme" });

    const data = await task.download();
    if (!data || !Buffer.isBuffer(data) || data.length < 32) {
      throw new Error("Empty response from iLovePDF download");
    }

    const outPath = path.join(
      os.tmpdir(),
      `portnet_ilovepdf_${Date.now()}_${path.basename(filePath)}`,
    );
    fs.writeFileSync(outPath, data);

    if (!this._isLikelyValidPdf(outPath)) {
      try {
        fs.unlinkSync(outPath);
      } catch {}
      throw new Error("iLovePDF returned an invalid PDF");
    }

    return outPath;
  }

  async _compressViaGhostscript(filePath, sizeBytes, maxBytes) {
    const gsCandidates = this._resolveGhostscriptExecutables();
    const sizeMBNum = sizeBytes / (1024 * 1024);
    const timeoutMs = Math.max(
      GS_TIMEOUT_MS,
      Math.ceil(sizeMBNum) * GS_TIMEOUT_PER_MB_MS,
    );

    let qualities =
      GS_PROFILE === "full"
        ? ["/printer", "/ebook", "/screen"]
        : ["/ebook", "/screen"];
    if (GS_PROFILE !== "full" && sizeMBNum >= GS_LARGE_FILE_MB) {
      qualities = ["/screen"];
    }

    log.info(
      `PDF compress config: profile=${GS_PROFILE}, timeout=${timeoutMs}ms, qualities=${qualities.join(" -> ")}`,
    );

    let bestValidOutPath = null;
    let bestValidOutSize = Number.POSITIVE_INFINITY;

    for (const gsExe of gsCandidates) {
      for (const quality of qualities) {
        const outPath = path.join(
          os.tmpdir(),
          `portnet_gs_${Date.now()}_${gsExe.replace(/\W/g, "")}_${quality.replace("/", "")}_${path.basename(filePath)}`,
        );

        const colorRes = quality === "/screen" ? "72" : "150";
        const grayRes = quality === "/screen" ? "72" : "150";

        try {
          await execFileAsync(
            gsExe,
            [
              "-sDEVICE=pdfwrite",
              "-dCompatibilityLevel=1.4",
              `-dPDFSETTINGS=${quality}`,
              "-dDownsampleColorImages=true",
              "-dDownsampleGrayImages=true",
              "-dDownsampleMonoImages=true",
              `-dColorImageResolution=${colorRes}`,
              `-dGrayImageResolution=${grayRes}`,
              "-dMonoImageResolution=300",
              "-dDetectDuplicateImages=true",
              "-dCompressFonts=true",
              "-dSubsetFonts=true",
              "-dNOPAUSE",
              "-dQUIET",
              "-dBATCH",
              `-sOutputFile=${outPath}`,
              filePath,
            ],
            { timeout: timeoutMs },
          );

          if (!fs.existsSync(outPath)) continue;
          if (!this._isLikelyValidPdf(outPath)) {
            log.warn(
              `PDF compress (GS): invalid/corrupt output detected (${gsExe}, ${quality})`,
            );
            try {
              fs.unlinkSync(outPath);
            } catch {}
            continue;
          }

          const outSize = fs.statSync(outPath).size;
          const outMB = (outSize / (1024 * 1024)).toFixed(1);

          if (outSize < bestValidOutSize) {
            if (bestValidOutPath && bestValidOutPath !== outPath) {
              try {
                fs.unlinkSync(bestValidOutPath);
              } catch {}
            }
            bestValidOutPath = outPath;
            bestValidOutSize = outSize;
          }

          if (outSize <= maxBytes) {
            log.info(
              `PDF compress (GS): ✓ compressed to ${outMB} MB (${quality}) → "${outPath}"`,
            );
            return outPath;
          }

          log.info(
            `PDF compress (GS): ${outMB} MB with ${quality}, trying lower quality…`,
          );
        } catch (err) {
          try {
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
          } catch {}

          const stderrText = String(err?.stderr || "");
          const isMissingExecutable =
            err?.code === "ENOENT" ||
            stderrText.includes("not recognized") ||
            stderrText.includes("No such file or directory");

          if (isMissingExecutable) break;

          const stderrSnippet = stderrText
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 400);

          log.warn(
            `PDF compress (GS) attempt failed (${gsExe}, ${quality}, timeout=${timeoutMs}ms): ${err?.message || "unknown error"}${stderrSnippet ? ` | stderr: ${stderrSnippet}` : ""}`,
          );
        }
      }
    }

    if (bestValidOutPath && fs.existsSync(bestValidOutPath)) {
      const outMB = (fs.statSync(bestValidOutPath).size / (1024 * 1024)).toFixed(
        1,
      );
      log.warn(
        `PDF compress (GS): best valid result is ${outMB} MB – proceeding with it`,
      );
      return bestValidOutPath;
    }

    log.warn(
      "PDF compress: all compression attempts failed – using original file",
    );
    return filePath;
  }

  // ── Annexe section ─────────────────────────────────────────────────────────
  /**
   * Upload Manifeste (FACTURE) + MAWB (TITRE DE TRANSPORT) PDFs from folderPath.
   * Files must match Manifest*.pdf and MAWB*.pdf (case-insensitive).
   * Portnet accepts max 2 MB per file – a warning is logged if exceeded.
   */
  async fillAnnexe(folderPath) {
    const f = this.frame;
    const compressedOutputDir = path.join(folderPath, "compressed");

    // Wait for the Annexe section to render after Connaissement Ajouter
    await f
      .locator('h4:has-text("Annexe")')
      .first()
      .waitFor({ state: "visible", timeout: 20000 });
    log.info("Annexe section visible – starting document uploads");

    // Navigate UP from the exact "Annexe" h4 to its nearest MuiPaper-root ancestor.
    // Using .filter({ has }) can match outer wrapper papers that also contain the heading
    // as a deep descendant, causing the wrong "Ajouter" (Connaissement) to be clicked.
    const annexeSection = f
      .locator("h4")
      .filter({ hasText: /^Annexe$/ })
      .locator('xpath=ancestor::div[contains(@class,"MuiPaper-root")][1]');

    // Scoped grid locator – only the Annexe section's DataGrid
    const annexeGrid = annexeSection.locator('[role="grid"]').first();

    /**
     * Upload one document and wait until the Annexe grid reaches expectedRowCount rows.
     * expectedRowCount is 1-based (1 after first upload, 2 after second, etc.)
     */
    const uploadFile = async (
      typeDataValue,
      filenamePredicate,
      label,
      expectedRowCount,
    ) => {
      let dirEntries;
      try {
        dirEntries = fs.readdirSync(folderPath);
      } catch (e) {
        log.warn(`Annexe: cannot read folder "${folderPath}": ${e.message}`);
        return;
      }

      const matched = dirEntries.find(
        (n) =>
          filenamePredicate(n.toLowerCase()) &&
          n.toLowerCase().endsWith(".pdf"),
      );
      if (!matched) {
        log.warn(
          `Annexe: no file matching (${label}) in "${folderPath}" – skipping`,
        );
        return;
      }

      const fullPath = path.join(folderPath, matched);

      // Compress to ≤ 2 MB if needed (uses Ghostscript)
      const uploadPath = await this._compressPdfIfNeeded(fullPath);
      const uploadSizeKB = (fs.statSync(uploadPath).size / 1024).toFixed(0);
      const sourceUsed = uploadPath === fullPath ? "original" : "compressed";

      // Always persist the prepared (compressed or original) document in
      // <current LTA>/compressed for manual verification.
      fs.mkdirSync(compressedOutputDir, { recursive: true });
      const baseName = path.parse(matched).name;
      const savedCompressedPath = path.join(
        compressedOutputDir,
        `${baseName}_compressed.pdf`,
      );
      fs.copyFileSync(uploadPath, savedCompressedPath);
      log.info(
        `Annexe: saved prepared file to "${savedCompressedPath}" (source=${sourceUsed}, size=${uploadSizeKB} KB)`,
      );

      // Debug stop mode: stop right after compression/save, before upload.
      if (STOP_AFTER_ANNEX_COMPRESSION) {
        log.warn(
          `Annexe debug stop active. Skipping upload for "${matched}" after compression.`,
        );
        return { stoppedAfterCompression: true };
      }

      log.info(
        `Annexe: uploading "${matched}" (${uploadSizeKB} KB) as ${label}`,
      );

      // Select document type
      await this._muiSelect("mui-component-select-typeDocument", typeDataValue);
      await this.page.waitForTimeout(500);

      // Set file on the hidden <input type="file"> inside the Annexe section.
      // Always use the original filename (matched) regardless of whether the file
      // was compressed to a temp path, so Portnet sees the correct document name.
      const fileInput = annexeSection.locator(
        'input[type="file"][accept=".pdf"]',
      );
      await fileInput.setInputFiles({
        name: matched,
        mimeType: "application/pdf",
        buffer: fs.readFileSync(uploadPath),
      });
      await this.page.waitForTimeout(500);

      // Click Ajouter scoped to Annexe section
      await annexeSection.locator('button:has-text("Ajouter")').first().click();
      log.info(
        `Annexe: Ajouter clicked for "${matched}" – waiting for ${expectedRowCount} row(s) in grid…`,
      );

      // Poll the Annexe grid's aria-rowcount until it reflects the new row.
      // aria-rowcount = data rows + 1 (aria counts the header row too), so
      // 1 uploaded doc → aria-rowcount "2", 2 docs → "3", etc.
      const deadline = Date.now() + 15000;
      let verified = false;
      while (Date.now() < deadline) {
        const rowCount = await annexeGrid
          .locator('.MuiDataGrid-row[role="row"]')
          .count()
          .catch(() => 0);
        if (rowCount >= expectedRowCount) {
          verified = true;
          break;
        }
        await this.page.waitForTimeout(600);
      }

      if (verified) {
        log.info(
          `Annexe: ✓ "${matched}" confirmed in grid (${expectedRowCount} row(s) visible)`,
        );
      } else {
        log.warn(
          `Annexe: ✗ "${matched}" – grid did not reach ${expectedRowCount} row(s) within 15 s`,
        );
      }
      await this.page.waitForTimeout(500);

      return { stoppedAfterCompression: false };
    };

    // 1. Manifeste → A0006 - FACTURE (data-value="1")  → expect 1 row
    const manifestResult = await uploadFile(
      "1",
      (n) => n.startsWith("manifest") || n.startsWith("manifeste"),
      "A0006 - FACTURE",
      1,
    );

    // 2. MAWB → A0004 - TITRE DE PROPRIÉTÉ ET/OU DE TRANSPORT (data-value="7") → expect 2 rows
    const mawbResult = await uploadFile(
      "7",
      (n) => n.startsWith("mawb"),
      "A0004 - TITRE DE TRANSPORT",
      2,
    );

    if (
      manifestResult?.stoppedAfterCompression ||
      mawbResult?.stoppedAfterCompression
    ) {
      log.warn(
        `Annexe debug stop active. Prepared files are available in "${compressedOutputDir}".`,
      );
      return { stoppedAfterCompression: true, compressedOutputDir };
    }

    log.info("Annexe: both documents uploaded and verified in grid");
    return { stoppedAfterCompression: false, compressedOutputDir };
  }

  // ── Demandes diverses section ───────────────────────────────────────────────
  /**
   * Fill the "Demandes diverses" section:
   *   Type de diverse = 01 - Autres (data-value="1")
   *   Demande = "Scellés N° {scelle1}-{scelle2}"
   *   Click Ajouter
   */
  async fillDemandesDiverses(scelle1, scelle2) {
    const f = this.frame;

    await f
      .locator('h4:has-text("Demandes diverses")')
      .first()
      .waitFor({ state: "visible", timeout: 15000 });
    log.info("Demandes diverses section visible");

    // Navigate UP from the exact "Demandes diverses" h4 to its nearest MuiPaper-root ancestor.
    // Using .filter({ has }) can match outer wrapper papers and cause the wrong Ajouter to be clicked.
    const demandesSection = f
      .locator("h4")
      .filter({ hasText: /^Demandes diverses$/ })
      .locator('xpath=ancestor::div[contains(@class,"MuiPaper-root")][1]');

    // Select Type de diverse = "01 - Autres" (data-value="1")
    await this._muiSelect("mui-component-select-typeId", "1");
    await this.page.waitForTimeout(400);

    // Fill Demande text
    const demandeText = `Scellés N° ${scelle1}-${scelle2}`;
    const demandeInput = demandesSection.locator('input[maxlength="255"]');
    await demandeInput.fill(demandeText);
    log.info(`Demandes diverses: filled "${demandeText}"`);
    await this.page.waitForTimeout(300);

    // Click Ajouter scoped to Demandes diverses section
    await demandesSection.locator('button:has-text("Ajouter")').first().click();
    await this.page.waitForTimeout(1500);
    log.info(`Demandes diverses: row added – "${demandeText}"`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Mead Combine: Équipement et Marchandises sub-form
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Clicks the AssistantIcon ("Gérer les équipements/marchandises") on the
   * Connaissement grid row, fills the Mead Combine sub-form, then clicks
   * Retour to return to the DS Combinée main form.
   *
   * Required formData fields:
   *   nombreContenant – number of packages (from acheminement.json)
   *   poidsBrut       – gross weight in kg  (= poidTotal from acheminement)
   *   refNumber       – MAWB/LTA reference  (used as Marque)
   *   montant         – invoice value
   *   deviseId        – currency code (USD / EUR / MAD)
   */
  async fillEquipementsMarchandises(formData) {
    const f = this.frame;
    log.info("Mead Combine: clicking Gérer les équipements/marchandises…");

    // 1. Click the AssistantIcon tooltip button on the Connaissement row
    await f
      .locator('[aria-label="Gérer les équipements/marchandises"]')
      .first()
      .click();

    // 2. Wait for the Mead Combine page to load inside the iframe
    await f
      .locator('input[name="nombreContenant"]')
      .waitFor({ state: "visible", timeout: 20000 });
    log.info("Mead Combine form loaded");

    // 3. Type Contenant = COLIS (data-value="42 - 216")
    await this._muiSelect("mui-component-select-typeContenantId", "42 - 216");

    // 4. Nombre Contenant(s)
    await f
      .locator('input[name="nombreContenant"]')
      .fill(String(formData.nombreContenant));

    // 5. Poids Brut (kg)
    await f.locator('input[name="poidsBrut"]').fill(String(formData.poidsBrut));

    // 6. Marque = MAWB/LTA reference number
    const normalizedRefNumber = this._normalizeLotReference(formData.refNumber);
    await f.locator('input[name="marque"]').fill(normalizedRefNumber);

    // 7. Nature Marchandise (always fixed)
    await f.locator('input[name="natureMarchandise"]').fill("COURIERE EXPRESS");

    // 8. ONSSA = Non (data-value="n")
    await this._muiSelect("mui-component-select-soumisOuControleParONSSA", "n");

    // 9. Code SH – SearchIcon → dialog → Rechercher → last page → click last row
    await f
      .locator(
        '.MuiInputBase-root:has(input[name="marchandiseDouane"]) [data-testid="SearchIcon"]',
      )
      .click();

    // Wait for the "Rechercher Marchandises" dialog to appear
    const shDialog = f.locator('[role="dialog"]').filter({
      has: f.locator('h2:has-text("Rechercher Marchandises")'),
    });
    await shDialog.waitFor({ state: "visible", timeout: 15000 });
    log.info("Code SH dialog opened");

    // Click Rechercher (with empty filters → all 16 000+ codes)
    await shDialog.locator('button:has-text("Rechercher")').first().click();
    await this.page.waitForTimeout(1500);

    // Navigate to the last page
    const shLastPage = shDialog.locator('button[aria-label="Go to last page"]');
    const lastPageDisabled = await shLastPage
      .getAttribute("disabled")
      .catch(() => "disabled");
    if (lastPageDisabled === null) {
      // attribute absent → button is enabled
      await shLastPage.click();
      await this.page.waitForTimeout(1200);
    }

    // Click the last visible row (row click selects + closes the dialog)
    await shDialog.locator(".MuiDataGrid-row--lastVisible").first().click();
    log.info("Code SH selected (last row – 9999 Autres)");

    // Wait for dialog to be gone
    await shDialog
      .waitFor({ state: "hidden", timeout: 10000 })
      .catch(() => log.warn("Code SH dialog may still be visible"));

    // 10. Montant
    await f.locator('input[name="montant"]').fill(String(formData.montant));

    // 11. Devise
    if (formData.deviseId) {
      const deviseLabel =
        DEVISE_MAP[formData.deviseId.toUpperCase()] || formData.deviseId;
      await this._muiSelectByText("mui-component-select-deviseId", deviseLabel);
    }

    // 12. Ajouter (submit the marchandise row)
    await f
      .locator('button[type="submit"]:has-text("Ajouter")')
      .first()
      .click();
    log.info("Mead Combine: Ajouter clicked – waiting for grid row…");
    await f
      .locator(".MuiDataGrid-row")
      .first()
      .waitFor({ state: "visible", timeout: 15000 })
      .catch(() =>
        log.warn("Mead Combine: no grid row appeared after Ajouter"),
      );
    await this.page.waitForTimeout(1000);

    // 13. Retour → back to DS Combinée main form
    await f.locator('button:has-text("Retour")').first().click();
    log.info("Mead Combine: Retour – waiting for DS main form…");
    // Wait for the Annexe heading or Demandes diverses heading to confirm return
    await f
      .locator(
        'h4:has-text("Annexe"), h4:has-text("Demandes diverses"), h4:has-text("Connaissement")',
      )
      .first()
      .waitFor({ state: "visible", timeout: 20000 });
    log.info("Mead Combine: complete, back on DS Combinée form");
  }

  // ── Full form fill orchestration ───────────────────────────────────────────

  async fillEntete(formData) {
    log.info("Starting DS Combinée Entête form fill…", formData);

    await this.navigate();
    await this.selectAgrement();
    await this.selectAnticipationNon();
    await this.selectTypeDSReference();
    await this.searchAndSelectDSReference(formData.sequenceNum);

    await this.page.waitForTimeout(1500);

    await this.selectArrondissement();
    await this.selectLieuStockage();
    await this.selectBureauDestination();
    await this.selectAvecMoyenTransportNon();
    await this.selectPaysProvenance();
    await this.selectPaysDestination();
    await this.fillDateVoyage();

    if (formData.montant !== undefined) {
      await this.fillMontant(formData.montant, formData.deviseId);
    }

    // Always read the Aerport input that Portnet auto-fills in the Entête form.
    // This is the value we pass to the Connaissement "Lieu de chargement" search.
    // (formData.lieuChargement is the BADR lieu used for Préapurement DS, which
    //  can differ from the airport code/name shown in the Portnet Aerport field.)
    const airportValue = await this.frame
      .locator(".MuiFormControl-root")
      .filter({ has: this.frame.locator('label:has-text("Aerport")') })
      .first()
      .locator("input")
      .inputValue()
      .catch(() => "");
    log.info(`Aerport field value (for Connaissement lieu): "${airportValue}"`);

    // ── Caution section ──────────────────────────────────────────────────────
    await this.fillCaution();

    // ── Connaissement section ────────────────────────────────────────────────
    if (formData.refNumber) {
      await this.fillConnaissement(formData.refNumber, airportValue);
    } else {
      log.info("No refNumber in formData – skipping Connaissement fill");
    }

    // ── Mead Combine: Équipement et Marchandises ─────────────────────────────
    if (
      formData.refNumber &&
      formData.nombreContenant != null &&
      formData.nombreContenant !== "" &&
      formData.poidsBrut != null &&
      formData.poidsBrut !== ""
    ) {
      await this.fillEquipementsMarchandises(formData);
    } else {
      log.warn(
        "Skipping fillEquipementsMarchandises – missing nombreContenant or poidsBrut",
      );
    }

    // ── Annexe section ───────────────────────────────────────────────────────
    if (formData.folderPath) {
      const annexeResult = await this.fillAnnexe(formData.folderPath);
      if (annexeResult?.stoppedAfterCompression) {
        log.warn(
          `Stopping flow after annexe compression debug mode. Check files in "${annexeResult.compressedOutputDir}".`,
        );
        return {
          stoppedAfterAnnexCompression: true,
          compressedOutputDir: annexeResult.compressedOutputDir,
        };
      }
    } else {
      log.warn("No folderPath in formData – skipping Annexe upload");
    }

    // ── Demandes diverses section ────────────────────────────────────────────
    if (formData.scelle1 && formData.scelle2) {
      await this.fillDemandesDiverses(formData.scelle1, formData.scelle2);
    } else {
      log.warn("No scelle1/scelle2 in formData – skipping Demandes diverses");
    }

    log.info(
      "DS Combinée form fill complete (Entête + Caution + Connaissement + Équipements + Annexe + Demandes diverses)",
    );

    return {
      stoppedAfterAnnexCompression: false,
    };
  }

  // ── Final Submission and Status Polling ────────────────────────────────────
  buildPortnetReference(sequenceNumRaw) {
    const sequenceNum = String(sequenceNumRaw || "").trim();
    const targetRef = sequenceNum.replace(/[-\s]/g, "");
    const year = new Date().getFullYear();

    return `301000${year}${targetRef.padStart(8, "0")}`;
  }

  async submitRequest(sequenceNumRaw) {
    const sequenceNum = String(sequenceNumRaw || "").trim();
    const portnetRef = this.buildPortnetReference(sequenceNum);

    log.info(
      `Ready to submit for sequence: ${sequenceNum} (Portnet Format: ${portnetRef})`,
    );

    await this.frame
      .locator('button:has-text("Envoyer DS MEAD Combinée")')
      .click();
    log.info("Mead Combine: 'Envoyer DS MEAD Combinée' clicked.");

    await this.page.waitForTimeout(5000);
    return portnetRef;
  }

  async openConsultationPage() {
    log.info("Navigating to Consultation page to poll status...");
    await this.page.goto("https://cargo.portnet.ma/dsCombine/consultation", {
      waitUntil: "networkidle",
    });

    // Ensure newest rows are shown first to reduce ambiguity on shared dsReference.
    await this._ensureConsultationSortedByCreatedAtDesc();
  }

  async _ensureConsultationSortedByCreatedAtDesc() {
    const pollFrame = this.page.frameLocator('iframe[title="iframe"]');
    const createdAtHeader = pollFrame.locator(
      '[role="columnheader"][data-field="createdAtFormatted"]',
    );

    await createdAtHeader.waitFor({ state: "visible", timeout: 30000 });

    for (let i = 0; i < 3; i++) {
      const sort = (await createdAtHeader.getAttribute("aria-sort")) || "none";
      if (sort === "descending") {
        log.info("Consultation sorted by Date de creation (descending)");
        return;
      }

      await createdAtHeader.scrollIntoViewIfNeeded().catch(() => {});

      // MUI DataGrid often hides the sort icon button until hover/focus.
      // Clicking the header itself is more reliable across rerenders.
      const sortButton = createdAtHeader
        .locator('button[aria-label="Sort"]')
        .first();
      const buttonVisible = await sortButton.isVisible().catch(() => false);

      if (buttonVisible) {
        await sortButton.click();
      } else {
        await createdAtHeader.click();
      }

      await this.page.waitForTimeout(500);

      const afterSort =
        (await createdAtHeader.getAttribute("aria-sort").catch(() => "none")) ||
        "none";
      if (afterSort === "descending") {
        log.info("Consultation sorted by Date de creation (descending)");
        return;
      }
    }

    log.warn(
      "Could not confirm descending sort on Date de creation header. Continuing with current order.",
    );
  }

  _parseCreatedAtToTimestamp(createdAtRaw) {
    const raw = String(createdAtRaw || "").trim();
    const match = raw.match(
      /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/,
    );
    if (!match) return null;

    const [, dd, mm, yyyy, hh, min, ss = "00"] = match;
    const asDate = new Date(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(min),
      Number(ss),
      0,
    );

    const ts = asDate.getTime();
    return Number.isFinite(ts) ? ts : null;
  }

  async _extractRefDsMead(row) {
    const cellLocator = row.locator('div[data-field="refDsMead"]');

    // Wait for cell to be visible first
    await cellLocator
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => {});

    // Strategy 1: aria-label on the tooltip/text container div
    let value =
      (await cellLocator
        .locator("div[aria-label]")
        .first()
        .getAttribute("aria-label")
        .catch(() => "")) || "";

    if (value && value.trim()) return value.trim();

    // Strategy 1b: aria-label directly on the cell itself
    value =
      (await cellLocator.getAttribute("aria-label").catch(() => "")) || "";
    if (value && value.trim()) return value.trim();

    // Strategy 2: textContent
    value = (await cellLocator.textContent().catch(() => "")) || "";
    if (value && value.trim()) return value.trim();

    // Strategy 3: innerText
    value = (await cellLocator.innerText().catch(() => "")) || "";
    if (value && value.trim()) return value.trim();

    // Strategy 4: evaluate with JavaScript in case rendering is delayed
    value =
      (await cellLocator
        .evaluate((el) => {
          // Try aria-label on children first
          const labeled = el.querySelector("[aria-label]");
          if (labeled?.ariaLabel) return labeled.ariaLabel;
          // Try textContent
          return el.textContent?.trim() || "";
        })
        .catch(() => "")) || "";

    if (value && value.trim()) return value.trim();

    return "";
  }

  _normalizeRefDs(refDsRaw) {
    const raw = String(refDsRaw || "").trim();
    if (!raw || raw === "undefined") return "";

    const compact = raw.replace(/\s+/g, "");
    const shortRef = compact.length > 10 ? compact.substring(10) : compact;
    return shortRef.replace(/^0+/, "");
  }

  async getConsultationStatus(portnetRef, options = {}) {
    /**
     * Consultation status lookup with deterministic row anchoring.
     * @param {string} portnetRef - DS Combined reference to find
     * @param {object} options
     *   - submittedAt: ISO timestamp for time-window matching
     *   - excludeRefDs: array of refDsMead already claimed
     *   - anchorCreatedAtRaw: "DD-MM-YYYY HH:MM" to lock on specific row (when shared dsReference)
     *   - anchorNumeroManifesteRaw: manifeste ID to disambiguate rows with same createdAt
     *   - preferNewest: if multi candidates, prefer latest (ignores time-window)
     */
    const submittedAtTs = options.submittedAt
      ? new Date(options.submittedAt).getTime()
      : null;
    const anchorCreatedAtRaw = String(options.anchorCreatedAtRaw || "").trim();
    const anchorNumeroManifesteRaw = String(
      options.anchorNumeroManifesteRaw || "",
    ).trim();
    const preferNewest = options.preferNewest === true;
    const excludeRefDs = new Set(
      (options.excludeRefDs || [])
        .map((ref) => this._normalizeRefDs(ref))
        .filter(Boolean),
    );
    const pollFrame = this.page.frameLocator('iframe[title="iframe"]');

    await pollFrame
      .locator('div[role="grid"]')
      .first()
      .waitFor({ state: "visible", timeout: 30000 })
      .catch(() => log.warn("Table not visible yet..."));

    const rows = pollFrame.locator(
      `div[role="row"]:has(div[data-field="dsReference"] div[aria-label="${portnetRef}"])`,
    );

    const matchCount = await rows.count();
    if (matchCount === 0) {
      return {
        found: false,
        statusText: "",
        refDsRaw: "",
        matchesCount: 0,
      };
    }

    const allMatches = [];

    for (let i = 0; i < matchCount; i++) {
      const row = rows.nth(i);

      const statusText =
        (await row
          .locator(
            'div[data-field="dsCombineStatusDescription"] div[aria-label]',
          )
          .getAttribute("aria-label")
          .catch(() => "")) || "";

      let refDsRaw = await this._extractRefDsMead(row);
      refDsRaw = String(refDsRaw || "").trim();

      const createdAtRaw =
        (await row
          .locator('div[data-field="createdAtFormatted"] div[aria-label]')
          .getAttribute("aria-label")
          .catch(() => "")) || "";

      const numeroManifesteRaw =
        (await row
          .locator('div[data-field="numeroManifeste"] div[aria-label]')
          .getAttribute("aria-label")
          .catch(() => "")) || "";

      allMatches.push({
        rowIndex: i,
        statusText,
        refDsRaw,
        refDsShort: this._normalizeRefDs(refDsRaw),
        createdAtRaw,
        createdAtTs: this._parseCreatedAtToTimestamp(createdAtRaw),
        numeroManifesteRaw,
      });
    }

    if (anchorCreatedAtRaw) {
      // Find rows matching the anchor timestamp
      const anchoredRows = allMatches.filter(
        (m) => String(m.createdAtRaw || "").trim() === anchorCreatedAtRaw,
      );

      if (anchoredRows.length > 0) {
        let target = null;

        // If we have a manifeste anchor too, use it as primary key
        if (options.anchorNumeroManifesteRaw) {
          const manifesteAnchor = String(
            options.anchorNumeroManifesteRaw || "",
          ).trim();
          target = anchoredRows.find(
            (m) =>
              String(m.numeroManifesteRaw || "").trim() === manifesteAnchor,
          );
        }

        // Fallback: prefer Acceptée row with non-empty refDsRaw
        if (!target) {
          target = anchoredRows.find(
            (m) =>
              (m.statusText === "Acceptée" || m.statusText === "Acceptee") &&
              m.refDsRaw &&
              m.refDsRaw.trim(),
          );
        }

        // Final fallback: just take first anchored row
        if (!target) {
          target = anchoredRows[0];
        }

        const targetAccepted =
          (target.statusText === "Acceptée" ||
            target.statusText === "Acceptee") &&
          target.refDsShort &&
          !excludeRefDs.has(target.refDsShort);

        return {
          found: true,
          statusText: target.statusText || "",
          refDsRaw: targetAccepted ? target.refDsRaw : "",
          createdAtRaw: target.createdAtRaw || "",
          numeroManifesteRaw: target.numeroManifesteRaw || "",
          matchesCount: matchCount,
        };
      }
    }

    // When submittedAt is known, bind this check to ONE row: the row whose
    // creation time is closest to this request submission time.
    if (Number.isFinite(submittedAtTs)) {
      const lowerBoundTs = submittedAtTs - 30 * 60 * 1000;
      const upperBoundTs = submittedAtTs + 180 * 60 * 1000;

      const timeCandidates = allMatches.filter(
        (m) =>
          Number.isFinite(m.createdAtTs) &&
          m.createdAtTs >= lowerBoundTs &&
          m.createdAtTs <= upperBoundTs,
      );

      if (timeCandidates.length === 0) {
        log.warn(
          `No consultation row in time window for ${portnetRef} (submittedAt=${options.submittedAt}). Falling back to closest row outside window.`,
        );

        const sortable = allMatches
          .filter((m) => Number.isFinite(m.createdAtTs))
          .sort((a, b) => {
            const da = Math.abs(a.createdAtTs - submittedAtTs);
            const db = Math.abs(b.createdAtTs - submittedAtTs);
            if (da !== db) return da - db;
            return (b.createdAtTs || 0) - (a.createdAtTs || 0);
          });

        const fallbackTarget = sortable[0] || allMatches[0];
        const fallbackAccepted =
          (fallbackTarget?.statusText === "Acceptée" ||
            fallbackTarget?.statusText === "Acceptee") &&
          fallbackTarget?.refDsShort &&
          !excludeRefDs.has(fallbackTarget.refDsShort);

        return {
          found: true,
          statusText: fallbackTarget?.statusText || "",
          refDsRaw: fallbackAccepted ? fallbackTarget.refDsRaw : "",
          createdAtRaw: fallbackTarget?.createdAtRaw || "",
          matchesCount: matchCount,
        };
      }

      timeCandidates.sort((a, b) => {
        if (preferNewest) {
          return (b.createdAtTs || 0) - (a.createdAtTs || 0);
        }

        const da = Math.abs(a.createdAtTs - submittedAtTs);
        const db = Math.abs(b.createdAtTs - submittedAtTs);
        if (da !== db) return da - db;
        return (a.createdAtTs || 0) - (b.createdAtTs || 0);
      });

      const target = timeCandidates[0];
      const isAccepted =
        target.statusText === "Acceptée" || target.statusText === "Acceptee";

      const canUseAcceptedRef =
        isAccepted && target.refDsShort && !excludeRefDs.has(target.refDsShort);

      return {
        found: true,
        statusText: target.statusText || "",
        refDsRaw: canUseAcceptedRef ? target.refDsRaw : "",
        createdAtRaw: target.createdAtRaw || "",
        numeroManifesteRaw: target.numeroManifesteRaw || "",
        matchesCount: matchCount,
      };
    }

    // Fallback path (no submittedAt available): prefer newest non-claimed accepted row.
    let acceptedCandidates = allMatches.filter(
      (m) =>
        (m.statusText === "Acceptée" || m.statusText === "Acceptee") &&
        m.refDsShort &&
        !excludeRefDs.has(m.refDsShort),
    );

    acceptedCandidates.sort(
      (a, b) => (b.createdAtTs || 0) - (a.createdAtTs || 0),
    );
    const bestAccepted = acceptedCandidates[0] || null;

    const fallbackRow = bestAccepted || allMatches[0];
    return {
      found: true,
      statusText: fallbackRow?.statusText || "",
      refDsRaw: bestAccepted?.refDsRaw || "",
      createdAtRaw: fallbackRow?.createdAtRaw || "",
      numeroManifesteRaw: fallbackRow?.numeroManifesteRaw || "",
      matchesCount: matchCount,
    };
  }

  /**
   * Clicks "Envoyer DS MEAD Combinée", waits for the consultation page,
   * and polls the table every 1 min until the status is "Acceptée".
   * Returns the short reference "XXXXX H".
   */
  async submitAndPollRequest(sequenceNumRaw) {
    const portnetRef = this.buildPortnetReference(sequenceNumRaw);
    await this.submitRequest(sequenceNumRaw);
    await this.openConsultationPage();

    let acceptedRefDs = null;
    let attempts = 0;
    const maxAttempts = 60; // 60 minutes

    while (attempts < maxAttempts) {
      log.info(
        `Poll attempt ${attempts + 1}/${maxAttempts} for DS ${portnetRef}...`,
      );
      const { found, statusText, refDsRaw } =
        await this.getConsultationStatus(portnetRef);

      if (found) {
        log.info(`Current status for ${portnetRef}: ${statusText}`);

        if (statusText === "Acceptée" || statusText === "Acceptee") {
          if (refDsRaw && refDsRaw !== "undefined") {
            log.info(`Found Accepted DS Reference: ${refDsRaw}`);
            acceptedRefDs = refDsRaw;
            break;
          }
        } else if (statusText === "Rejetée" || statusText === "Rejetee") {
          throw new Error(
            `DS Combinée request was REJECTED for ${portnetRef}! Please check manually.`,
          );
        }
      } else {
        log.info(`Row for ${portnetRef} not found in the table yet.`);
      }

      log.info("Not yet 'Acceptée'. Waiting 1 minute before refreshing...");
      await this.page.waitForTimeout(60000); // 1 minute
      await this.page.reload({ waitUntil: "networkidle" });
      attempts++;
    }

    if (!acceptedRefDs) {
      throw new Error(
        `Timed out waiting for Acceptée status for ${portnetRef}`,
      );
    }

    // Transform full string "30100020260001425H" -> "1425H"
    const shortRef = acceptedRefDs.substring(10).replace(/^0+/, "");
    log.info(`Extracted short reference from accepted DS: ${shortRef}`);
    return shortRef;
  }
}

module.exports = PortnetDsCombine;
