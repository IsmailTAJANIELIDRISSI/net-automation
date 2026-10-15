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

    // Série: strip leading zeros → plain number (e.g. '0003064' → '3064')
    const serieNum = String(parseInt(lotInfo.serie, 10));

    // Fill the lot fields, verifying each one actually stuck before clicking
    // OK — BADR's panels can render slowly (slow network/AJAX), so a plain
    // fill can silently land on nothing. Retry the whole lot (fresh
    // "Nouveau") up to 3 times rather than clicking OK with blanks.
    const maxAttempts = 3;
    let filled = false;
    let lastFailReason = "";

    for (let attempt = 1; attempt <= maxAttempts && !filled; attempt++) {
      if (attempt > 1) {
        log.warn(
          `Nouvelle tentative ${attempt}/${maxAttempts} (${lastFailReason})`,
        );
      }

      // Click "Nouveau"
      const btnNouveau = iframe.locator('button[name*="btnNouveauPreap"]');
      await btnNouveau.waitFor({ timeout: TIMEOUT });
      await btnNouveau.click();
      await this.page.waitForTimeout(500);
      log.info("Préapurement DS form opened");

      // Type DS: DS(01) — verify it stuck, or BADR rejects the lot with
      // "E13532: Type DS: Information obligatoire".
      const typeDsOk = await this._selectTypeDs(iframe, "DS(01)");
      if (!typeDsOk) {
        lastFailReason = "Type DS non sélectionné";
        continue;
      }

      const fields = [
        { selector: "input[id*='bureauId']", value: lotInfo.bureau, label: "Bureau" },
        { selector: "input[id*='regimeId']", value: lotInfo.regime, label: "Régime" },
        { selector: "input[id*='anneeId']", value: lotInfo.annee, label: "Année" },
        { selector: "input[id*='serieId']", value: serieNum, label: "Série" },
        { selector: "input[id*='cleId']", value: lotInfo.cle, label: "Clé" },
      ];

      let allFilled = true;
      for (const f of fields) {
        const ok = await this._fillAndVerify(iframe, f.selector, f.value, f.label);
        if (!ok) {
          lastFailReason = `champ "${f.label}" vide/non confirmé`;
          allFilled = false;
          break;
        }
      }
      if (!allFilled) continue;

      // Lieu de chargement — autocomplete; type the value from the lot search result
      if (lotInfo.lieuChargement) {
        const lieuInput = iframe.locator(
          "input[id*='lieuChargCmb'][role='textbox']",
        );
        await lieuInput.click();
        await lieuInput.fill("").catch(() => {});
        await lieuInput.pressSequentially(lotInfo.lieuChargement, {
          delay: 60,
        });
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
        const lieuVal = await lieuInput.inputValue().catch(() => "");
        if (!lieuVal.trim()) {
          lastFailReason = "lieu de chargement vide après sélection";
          continue;
        }
      }

      // Référence lot — the MAWB/LTA reference number
      // Field id: mainTab:form3:preapurement_ref_lot
      if (normalizedRefNumber) {
        const refLotInput = iframe.locator(
          "input[id*='preapurement_ref_lot']",
        );
        const refLotExists = await refLotInput
          .count()
          .then((n) => n > 0)
          .catch(() => false);
        if (refLotExists) {
          const refOk = await this._fillAndVerify(
            iframe,
            "input[id*='preapurement_ref_lot']",
            normalizedRefNumber,
            "Référence lot",
          );
          if (!refOk) {
            lastFailReason = `champ "Référence lot" vide/non confirmé`;
            continue;
          }
          log.info(`Référence lot filled: ${normalizedRefNumber}`);
        } else {
          log.warn(
            `Référence lot field not found — skipping (MAWB: ${normalizedRefNumber})`,
          );
        }
      }

      filled = true;
    }

    if (!filled) {
      throw new Error(
        `Préapurement DS: impossible de remplir les champs après ${maxAttempts} tentatives (${lastFailReason}) — abandon (réseau lent ou BADR instable)`,
      );
    }

    // Click OK
    log.info("Clicking OK to load poids brut…");
    await iframe.locator("button[id*='btnRefPreapOk']").click();
    await this.page.waitForTimeout(2000);

    // Don't let a blank/rejected lot fall through to a confusing "element not
    // found" error — check BADR's error banner first.
    if (await this._checkBadrError()) {
      const errText = await this.page
        .locator("#rapportMsgForm .ui-messages-error")
        .textContent()
        .catch(() => "");
      throw new Error(
        `Préapurement DS: BADR a renvoyé une erreur après clic OK ("${(errText || "").trim() || "message vide"}")`,
      );
    }

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

  /**
   * Returns true if BADR's error banner is currently visible.
   * Selector: form#rapportMsgForm with a visible .ui-messages-error child.
   */
  async _checkBadrError() {
    try {
      return await this.page
        .locator("#rapportMsgForm .ui-messages-error")
        .isVisible({ timeout: 1500 });
    } catch {
      return false;
    }
  }

  /**
   * Selects a PrimeFaces selectonemenu option (Type DS = "DS(01)") and
   * verifies the label actually shows it afterwards. See
   * badrDumNormalPartiel.js's _selectTypeDs for the full rationale (slow
   * BADR AJAX renders can leave Type DS unset, which BADR then rejects with
   * "E13532: Type DS: Information obligatoire").
   */
  async _selectTypeDs(iframe, label) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const container = iframe
        .locator("div#mainTab\\:form3\\:typeDsId")
        .first();
      const trigger = container.locator(".ui-selectonemenu-trigger").first();
      const visible = await trigger
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      if (!visible) {
        log.warn(`Type DS trigger non visible (tentative ${attempt}/3)`);
        await this.page.waitForTimeout(500);
        continue;
      }
      await trigger.click().catch(() => {});
      const item = iframe.locator(`li[data-label='${label}']`);
      const appeared = await item
        .first()
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      if (!appeared) {
        log.warn(`Liste Type DS non ouverte (tentative ${attempt}/3)`);
        await this.page.waitForTimeout(500);
        continue;
      }
      await item.first().click().catch(() => {});
      await this.page.waitForTimeout(300);
      const containerText = await container.textContent().catch(() => "");
      if (String(containerText).includes(label)) return true;
      log.warn(`Type DS non confirmé après sélection (tentative ${attempt}/3)`);
      await this.page.waitForTimeout(500);
    }
    return false;
  }

  /**
   * Fills a field then reads the value BACK to confirm it actually stuck,
   * retrying a few times. See badrDumNormalPartiel.js's _fillAndVerify for
   * the full rationale (slow BADR AJAX renders can make a plain .fill()
   * silently land on nothing).
   */
  async _fillAndVerify(iframe, selector, value, label) {
    const want = String(value ?? "").trim();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const el = iframe.locator(selector).first();
      const visible = await el.isVisible({ timeout: 3000 }).catch(() => false);
      if (!visible) {
        log.warn(`Champ "${label}" non visible (tentative ${attempt}/3)`);
        await this.page.waitForTimeout(500);
        continue;
      }
      await el.fill(want).catch(() => {});
      const actual = await el
        .inputValue()
        .then((v) => String(v).trim())
        .catch(() => "");
      if (actual === want) return true;
      log.warn(
        `Champ "${label}" non confirmé ("${actual}" ≠ "${want}"), tentative ${attempt}/3`,
      );
      await this.page.waitForTimeout(500);
    }
    return false;
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
