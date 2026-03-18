"use strict";
/**
 * BADRPreapurement – full flow:
 *   1. Expand DEDOUANEMENT panel → click Créer une déclaration (#_2001)
 *   2. Fill Bureau/Régime/Catégorie form inside #iframeMenu → Confirmer
 *   3. Click "Préapurement DS" tab (still inside iframe) → Nouveau
 *   4. Fill Type DS / Bureau / Régime / Année / Série / Clé / Lieu chargement → OK
 *   5. Read poids_brut + nombre_contenants → return them
 *
 * Returns: { poidsBrut: '12345.67', nombreContenants: '1' }
 */

const config = require("../config/config");
const { createLogger } = require("../utils/logger");

const log = createLogger("BADRPreapurement");

const TIMEOUT = config.timeout;

class BADRPreapurement {
  constructor(page) {
    this.page = page;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  PUBLIC API — called from main.js
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Complete weight-check flow.
   * @param {object} lotInfo — from BADRLotLookup (has .serie .cle .annee .lieuChargement)
   * @returns {{ poidsBrut: string, nombreContenants: string }}
   */
  async getPoidsBrut(lotInfo, refNumber) {
    log.info("Starting Préapurement DS flow…", {
      ref: lotInfo.declarationRef,
      mawb: refNumber,
    });

    // Step 1 — DEDOUANEMENT → Créer une déclaration → loads form in #iframeMenu
    const iframe = await this._openCreateDeclaration();

    // Step 2 — Fill Bureau/Régime/Catégorie inside iframe and confirm
    await this._fillCreateDeclarationForm(iframe);

    // Step 3 — Navigate to Préapurement DS tab (still in iframe after confirm)
    // Step 4 — Fill form and click OK
    return await this._fillPreapurementAndRead(iframe, lotInfo, refNumber);
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  STEP 1 — DEDOUANEMENT → Créer une déclaration
  // ──────────────────────────────────────────────────────────────────────────

  async _openCreateDeclaration() {
    const page = this.page;
    log.info("Expanding DEDOUANEMENT panel…");

    // The panel header is <h3> containing <a>DEDOUANEMENT</a>
    // Clicking the <a> link inside the header toggles the panel
    const dedouanementHeader = page
      .locator("#leftMenuId .ui-panelmenu-header a")
      .filter({ hasText: "DEDOUANEMENT" });
    const dedouanementContent = page.locator("#_2000");

    const isOpen = await dedouanementContent.isVisible().catch(() => false);
    if (!isOpen) {
      await dedouanementHeader.click();
      await page.waitForSelector("#_2000", {
        state: "visible",
        timeout: 10000,
      });
      await page.waitForTimeout(400);
    }

    log.info("Clicking Créer une déclaration (#_2001)…");
    await page.click("#_2001");

    // Wait for the iframe to load the creation form
    const iframe = page.frameLocator("#iframeMenu");
    await iframe
      .locator("#rootForm\\:btnConfirmer")
      .waitFor({ timeout: TIMEOUT });
    log.info("Create declaration form loaded in iframe");
    return iframe;
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  STEP 2 — Fill Bureau + Régime + Catégorie inside iframe → Confirmer
  // ──────────────────────────────────────────────────────────────────────────

  async _fillCreateDeclarationForm(iframe) {
    log.info(
      "Filling create declaration form (Bureau=301, Régime=010, Normale)…",
    );

    // PrimeFaces autocomplete REQUIRES pressSequentially — fill() doesn't fire keydown
    const inputs = iframe.locator(
      'input.ui-autocomplete-input[role="textbox"]',
    );

    // Bureau: 301
    const bureauInput = inputs.nth(0);
    await bureauInput.click();
    await bureauInput.pressSequentially(config.badr.bureauCode, { delay: 80 });
    await iframe
      .locator("li.ui-autocomplete-item")
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
    await iframe.locator("li.ui-autocomplete-item").first().click();
    await iframe.locator("body").click(); // dismiss
    await this.page.waitForTimeout(300);

    // Régime: 010
    const regimeInput = inputs.nth(1);
    await regimeInput.click();
    await regimeInput.pressSequentially("010", { delay: 80 });
    await iframe
      .locator("li.ui-autocomplete-item")
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
    await iframe.locator("li.ui-autocomplete-item").first().click();
    await this.page.waitForTimeout(300);

    // Radio: formulaire vierge (usually already selected by default)
    await iframe
      .locator("#rootForm\\:modeTransport_radioId1\\:0")
      .check()
      .catch(() => {});

    // Catégorie: Normale
    await iframe.locator("div.ui-selectonemenu-trigger").first().click();
    await iframe
      .locator('li[data-label="Normale"]')
      .waitFor({ state: "visible", timeout: 5000 });
    await iframe.locator('li[data-label="Normale"]').click();
    await this.page.waitForTimeout(300);

    // Confirm — this navigates the iframe to the declaration editing form
    log.info("Clicking Confirmer…");
    await iframe.locator("#rootForm\\:btnConfirmer").click();

    // Wait for the declaration tabs to appear inside the iframe
    await iframe
      .locator("a[href='#mainTab\\:tab3']")
      .waitFor({ timeout: TIMEOUT });
    log.info("Declaration created — tabs visible");
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  STEP 3+4 — Préapurement DS tab → Nouveau → fill form → OK → read result
  // ──────────────────────────────────────────────────────────────────────────

  async _fillPreapurementAndRead(iframe, lotInfo, refNumber) {
    const normalizedRefNumber = this._normalizeLotReference(refNumber);

    log.info("Clicking Préapurement DS tab…");
    await iframe.locator("a[href='#mainTab\\:tab3']").click();
    await this.page.waitForTimeout(800);

    // Click "Nouveau"
    const btnNouveau = iframe.locator('button[name*="btnNouveauPreap"]');
    await btnNouveau.waitFor({ timeout: TIMEOUT });
    await btnNouveau.click();
    await this.page.waitForTimeout(500);
    log.info("Préapurement DS form opened");

    // Type DS: DS(01)
    await iframe
      .locator("div#mainTab\\:form3\\:typeDsId div.ui-selectonemenu-trigger")
      .click();
    await iframe
      .locator("li[data-label='DS(01)']")
      .waitFor({ state: "visible", timeout: 5000 });
    await iframe.locator("li[data-label='DS(01)']").click();
    await this.page.waitForTimeout(200);

    // Bureau / Régime / Année / Série / Clé
    await iframe.locator("input[id*='bureauId']").fill(lotInfo.bureau);
    await iframe.locator("input[id*='regimeId']").fill(lotInfo.regime);
    await iframe.locator("input[id*='anneeId']").fill(lotInfo.annee);

    // Série: strip leading zeros → plain number (e.g. '0003064' → '3064')
    const serieNum = String(parseInt(lotInfo.serie, 10));
    await iframe.locator("input[id*='serieId']").fill(serieNum);
    await iframe.locator("input[id*='cleId']").fill(lotInfo.cle);

    // Lieu de chargement — autocomplete; type the value from the lot search result
    if (lotInfo.lieuChargement) {
      const lieuInput = iframe.locator(
        "input[id*='lieuChargCmb'][role='textbox']",
      );
      await lieuInput.click();
      await lieuInput.pressSequentially(lotInfo.lieuChargement, { delay: 60 });
      // wait for suggestion and select first match
      const suggPanel = iframe.locator(
        ".ui-autocomplete-panel li.ui-autocomplete-item",
      );
      const hasSugg = await suggPanel
        .first()
        .waitFor({ timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      if (hasSugg) {
        await suggPanel.first().click();
        log.info(`Lieu de chargement selected: ${lotInfo.lieuChargement}`);
      } else {
        log.warn(
          `No autocomplete suggestion for lieu "${lotInfo.lieuChargement}" — leaving typed value`,
        );
      }
      await this.page.waitForTimeout(300);
    }

    // Référence lot — the MAWB/LTA reference number
    // Field id: mainTab:form3:preapurement_ref_lot
    if (normalizedRefNumber) {
      const refLotInput = iframe.locator("input[id*='preapurement_ref_lot']");
      const refLotExists = await refLotInput
        .count()
        .then((n) => n > 0)
        .catch(() => false);
      if (refLotExists) {
        await refLotInput.click();
        await refLotInput.fill(normalizedRefNumber);
        log.info(`Référence lot filled: ${normalizedRefNumber}`);
        await this.page.waitForTimeout(300);
      } else {
        log.warn(
          `Référence lot field not found — skipping (MAWB: ${normalizedRefNumber})`,
        );
      }
    }

    // Click OK
    log.info("Clicking OK to load poids brut…");
    await iframe.locator("button[id*='btnRefPreapOk']").click();
    await this.page.waitForTimeout(2000);

    // Read results
    const poidsBrutEl = iframe.locator("#mainTab\\:form3\\:poidLotId");
    const nombreContenantsEl = iframe.locator(
      "#mainTab\\:form3\\:nbrContenantLotId",
    );

    await poidsBrutEl.waitFor({ timeout: TIMEOUT });

    const poidsBrut = (await poidsBrutEl.textContent()).trim();
    const nombreContenants = (
      await nombreContenantsEl.textContent().catch(() => "")
    ).trim();

    log.info("Préapurement result", { poidsBrut, nombreContenants });
    return { poidsBrut, nombreContenants };
  }

  _normalizeLotReference(lotReference) {
    const ref = String(lotReference || "").trim();
    const match = ref.match(/^(0+)(\d+)(-.+)$/);

    if (!match) return ref;

    const normalizedPrefix = String(parseInt(match[2], 10));
    return `${normalizedPrefix}${match[3]}`;
  }
}

module.exports = BADRPreapurement;
