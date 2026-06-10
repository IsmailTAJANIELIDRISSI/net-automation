"use strict";
/**
 * BADRDumNormalPartiel — automates the creation of a DUM Normale (Régime 085)
 * declaration in BADR for partiel LTAs (two-flight shipments).
 *
 * Usage:
 *   const dum = new BADRDumNormalPartiel(page);
 *   await dum.run(ach, badrConn);
 *
 * Where:
 *   ach      — full acheminement object (from acheminement.json)
 *   badrConn — BADRConnection instance (already logged in)
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { createLogger } = require("../utils/logger");
const { fetchMADRate, roundBADR } = require("../utils/exchangeRate");
const {
  compressPdfForAnnex,
  isLikelyValidPdf,
} = require("../utils/compressPdfChain");

const log = createLogger("BADRDumNormalPartiel");

// ── BADR session-error sentinel ──────────────────────────────────────────────
// Thrown when the BADR "erreur interne" banner is detected mid-flow.
// Caught in main.js to navigate home and retry from the saved phase.
class BadrSessionError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "BadrSessionError";
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function todayDDMMYYYY() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function sanitizeFilename(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9.\-_]/g, "_")
    .replace(/_+/g, "_");
}

class BADRDumNormalPartiel {
  /**
   * @param {import('playwright').Page} page - BADR main page (already logged in)
   */
  constructor(page) {
    this.page = page;
  }

  /**
   * Run the full 10-step DUM Normale Partiel flow.
   * Each step is guarded by the checkpoint phase so the flow can resume
   * from the last saved phase on restart.
   *
   * @param {object} ach      - acheminement object
   * @param {object} badrConn - BADRConnection instance
   * @param {function} updateState - callback(patch) to persist phase
   */
  async run(ach, badrConn, updateState) {
    const iframe = this.page.frameLocator("#iframeMenu");
    const phase = ach.automationState?.phase || "";

    log.info("Starting DUM Normale Partiel", {
      id: ach.id,
      phase,
      partiels: ach.partiels?.length,
    });

    // ── STEP 1 — Open Create Declaration ──────────────────────────────────
    if (
      !phase ||
      phase === "partiel_lots_found" ||
      phase === "partiel_waiting_lots"
    ) {
      await this._guardStep(
        "step1_openDeclaration",
        () => this._step1_openDeclaration(iframe, badrConn),
        badrConn,
      );
      updateState({ phase: "partiel_declaration_opened" });
    }

    // ── STEP 2 — Entête Tab ────────────────────────────────────────────────
    if (!this._isDone(ach, "partiel_entete_saved")) {
      ach = {
        ...ach,
        automationState: {
          ...(ach.automationState || {}),
          phase: "partiel_declaration_opened",
        },
      };
      await this._guardStep(
        "step2_entete",
        () => this._step2_entete(iframe, ach),
        badrConn,
      );
      updateState({ phase: "partiel_entete_saved" });
    }

    // ── STEP 3 — Moyen de Transport Tab ────────────────────────────────────
    if (!this._isDone(ach, "partiel_transport_saved")) {
      await this._guardStep(
        "step3_transport",
        () => this._step3_transport(iframe),
        badrConn,
      );
      updateState({ phase: "partiel_transport_saved" });
    }

    // ── STEP 4 — Caution Tab ───────────────────────────────────────────────
    if (!this._isDone(ach, "partiel_caution_saved")) {
      await this._guardStep(
        "step4_caution",
        () => this._step4_caution(iframe),
        badrConn,
      );
      updateState({ phase: "partiel_caution_saved" });
    }

    // ── STEP 5 — Préapurement DS Tab ───────────────────────────────────────
    if (!this._isDone(ach, "partiel_preapurement_done")) {
      const result = await this._guardStep(
        "step5_preapurement",
        () => this._step5_preapurement(iframe, ach),
        badrConn,
      );
      if (result.mismatch) {
        log.warn(
          `TODOMAIL — poids mismatch > 1 kg for "${ach.id}": ${result.errorMessage}`,
        );
        updateState({
          phase: "partiel_poids_mismatch",
          errorMessage: result.errorMessage,
        });
        throw new Error(result.errorMessage);
      }
      // Rounding diff ≤ 1 kg: use lot-authoritative poids for all downstream steps.
      if (result.poidsAdjusted) {
        log.info(
          `Poids correction: ${ach.poidTotal} → ${result.actualPoids} kg (rounding ≤ 1 kg)`,
        );
        ach = { ...ach, poidTotal: String(result.actualPoids) };
        // Persist corrected poidTotal to JSON so re-runs don't re-correct
        if (ach.folderPath) {
          try {
            const achFile = path.join(ach.folderPath, "acheminement.json");
            const saved = JSON.parse(fs.readFileSync(achFile, "utf8"));
            saved.poidTotal = String(result.actualPoids);
            fs.writeFileSync(achFile, JSON.stringify(saved, null, 2), "utf8");
            log.info(
              `Persisted corrected poidTotal=${result.actualPoids} to acheminement.json`,
            );
          } catch (e) {
            log.warn(`Could not persist poidTotal correction: ${e.message}`);
          }
        }
        await this._guardStep(
          "correct_entete_poids",
          () => this._correctEntePoids(iframe, result.actualPoids),
          badrConn,
        );
      }
      await this._guardStep(
        "sauvegarder_after_step5",
        () => this._sauvegarder(iframe),
        badrConn,
      );
      updateState({ phase: "partiel_preapurement_done" });
    }

    // ── STEP 6 — Documents Tab ─────────────────────────────────────────────
    if (!this._isDone(ach, "partiel_documents_saved")) {
      await this._guardStep(
        "step6_documents",
        () => this._step7_documents(iframe, ach),
        badrConn,
      );
      updateState({ phase: "partiel_documents_saved" });
    }

    // ── STEP 7 — Demandes Diverses Tab ─────────────────────────────────────
    if (!this._isDone(ach, "partiel_demandes_saved")) {
      await this._guardStep(
        "step7_demandes",
        () => this._step8_demandes(iframe, ach),
        badrConn,
      );
      updateState({ phase: "partiel_demandes_saved" });
    }

    // ── STEP 8 — Articles Tab ──────────────────────────────────────────────
    if (!this._isDone(ach, "partiel_articles_saved")) {
      await this._guardStep(
        "step8_articles",
        () => this._step9_articles(iframe, ach),
        badrConn,
      );
      updateState({ phase: "partiel_articles_saved" });
    }

    // ── STEP 9 — Print / Download ──────────────────────────────────────────
    // ── STEP 9 — Print / Download ─────────────────────────────────────────
    if (!this._isDone(ach, "partiel_pdf_saved")) {
      const result = await this._guardStep(
        "step9_print",
        () => this._step10_print(iframe, ach, updateState),
        badrConn,
      );
      updateState({
        phase: "partiel_pdf_saved",
        pdfPath: result.destPath,
        dumSerie: result.serie,
        dumCle: result.cle,
      });
      log.info("DUM Normale Partiel — PDF saved", { pdfPath: result.destPath });
    }

    // ── Scellés are NOT declared here automatically ────────────────────────
    // After printing the DUM, the user must manually sign the declaration in
    // BADR (this is a critical human-verification step).  The automation
    // stops at "partiel_pdf_saved" and waits for the user to:
    //   1. Go to BADR, sign the printed serie manually.
    //   2. Come back to the app, confirm/enter the signed serie.
    //   3. Click "Déclarer scellés" — which triggers automation:declare-scelles-partiel IPC.
    log.info(
      "DUM Normale Partiel — PDF printed. Waiting for manual signature before declaring scellés.",
    );
  }

  // ── BADR error detection & recovery ──────────────────────────────────────

  /**
   * Returns true if the BADR "erreur interne" banner is currently visible.
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
   * Wraps a step function with BADR error detection.
   * - If the step throws AND the error banner is visible → navigate to Accueil
   *   and throw BadrSessionError (caught by the retry loop in main.js).
   * - If the step throws for a different reason → re-throw as-is.
   * - After a successful step → also check for the banner (it can appear
   *   immediately after an action without throwing).
   * Returns whatever the step function returns.
   */
  async _guardStep(label, stepFn, badrConn) {
    let result;
    try {
      result = await stepFn();
    } catch (err) {
      if (await this._checkBadrError()) {
        log.warn(
          `BADR erreur interne pendant "${label}" — récupération vers Accueil…`,
        );
        await badrConn.navigateToAccueil().catch(() => {});
        await this.page.waitForTimeout(2000);
        throw new BadrSessionError(`BADR session error during: ${label}`);
      }
      throw err;
    }
    // Post-step check: banner can appear after a successful action
    if (await this._checkBadrError()) {
      log.warn(
        `BADR erreur interne après "${label}" — récupération vers Accueil…`,
      );
      await badrConn.navigateToAccueil().catch(() => {});
      await this.page.waitForTimeout(2000);
      throw new BadrSessionError(`BADR session error after: ${label}`);
    }
    return result;
  }

  // ── Phase guard ──────────────────────────────────────────────────────────

  _isDone(ach, targetPhase) {
    const order = [
      "partiel_declaration_opened",
      "partiel_entete_saved",
      "partiel_transport_saved",
      "partiel_caution_saved",
      "partiel_preapurement_done",
      "partiel_documents_saved",
      "partiel_demandes_saved",
      "partiel_articles_saved",
      "partiel_pdf_saved", // PDF downloaded; dumSerie/dumCle persisted in state
      "partiel_done", // scelles declared
    ];
    const current = ach.automationState?.phase || "";
    const currentIdx = order.indexOf(current);
    const targetIdx = order.indexOf(targetPhase);
    return currentIdx >= targetIdx && targetIdx >= 0;
  }

  // ── STEP 1 — Open Create Declaration ────────────────────────────────────

  async _step1_openDeclaration(iframe, badrConn) {
    const page = this.page;
    log.info("Step 1 — Opening Créer une déclaration…");

    // Expand DEDOUANEMENT panel
    const dedHeader = page
      .locator("#leftMenuId .ui-panelmenu-header a")
      .filter({ hasText: "DEDOUANEMENT" });
    const dedContent = page.locator("#_2000");
    const isOpen = await dedContent.isVisible().catch(() => false);
    if (!isOpen) {
      await dedHeader.click();
      await page.waitForSelector("#_2000", {
        state: "visible",
        timeout: 10000,
      });
      await page.waitForTimeout(400);
    }
    await page.click("#_2001");

    // Wait for iframe to load the creation form
    await page.waitForSelector("#iframeMenu", { timeout: 15000 });
    await iframe.locator("form").first().waitFor({ timeout: 20000 });

    // Wait for the form's Confirmer button — same reliable anchor used by BADRPreapurement
    await iframe
      .locator("#rootForm\\:btnConfirmer")
      .waitFor({ timeout: 30000 });
    log.info("Step 1 — Filling declaration creation form…");

    // PrimeFaces autocomplete inputs: use class selector (stable across pages).
    // nth(0) = Bureau, nth(1) = Régime — same order as in BADRPreapurement.
    const inputs = iframe.locator(
      'input.ui-autocomplete-input[role="textbox"]',
    );

    // Bureau = 301
    const bureauInput = inputs.nth(0);
    await bureauInput.click();
    await bureauInput.pressSequentially("301", { delay: 80 });
    await iframe
      .locator("li.ui-autocomplete-item")
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
    await iframe.locator("li.ui-autocomplete-item").first().click();
    await iframe.locator("body").click(); // dismiss dropdown
    await page.waitForTimeout(300);

    // Régime = 085
    const regimeInput = inputs.nth(1);
    await regimeInput.click();
    await regimeInput.pressSequentially("085", { delay: 80 });
    await iframe
      .locator("li.ui-autocomplete-item")
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
    await iframe.locator("li.ui-autocomplete-item").first().click();
    await page.waitForTimeout(300);

    // Catégorie = Normale (first selectonemenu trigger on the form)
    await iframe.locator("div.ui-selectonemenu-trigger").first().click();
    await iframe
      .locator("li[data-label='Normale']")
      .waitFor({ state: "visible", timeout: 5000 });
    await iframe.locator("li[data-label='Normale']").click();
    await page.waitForTimeout(200);

    // Radio: "Création à partir d'une déclaration existante"
    // The <input> is inside ui-helper-hidden-accessible — must click the
    // visual .ui-radiobutton-box inside table#rootForm:modeTransport_radioId2.
    await iframe
      .locator("table#rootForm\\:modeTransport_radioId2 .ui-radiobutton-box")
      .click();

    // Wait for AJAX to populate rootForm:panelRefDecExistante with reference fields
    await iframe
      .locator("#rootForm\\:panelRefDecExistante input:not([type='hidden'])")
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
      .catch(() => {});
    await page.waitForTimeout(300);

    // Fill reference fields using exact IDs from live DOM.
    // Régime (rootForm:refExist_regimeId) is readonly with value 085 — skip.
    await iframe.locator("#rootForm\\:refExist_bureauId").fill("301");
    await iframe.locator("#rootForm\\:refExist_anneeId").fill("2026");
    await iframe.locator("#rootForm\\:refExist_serieId").fill("1");
    await iframe.locator("#rootForm\\:refExist_cleId").fill("F");
    await page.waitForTimeout(200);

    // Checkbox "Déclaration enregistrée" — ID from live DOM: rootForm:cbxdedDecEnreg
    const enregBox = iframe.locator(
      "#rootForm\\:cbxdedDecEnreg .ui-chkbox-box",
    );
    if (await enregBox.isVisible({ timeout: 3000 }).catch(() => false)) {
      const isChecked = await enregBox
        .evaluate((el) => el.classList.contains("ui-state-active"))
        .catch(() => false);
      if (!isChecked) await enregBox.click();
      await page.waitForTimeout(200);
    }

    // Confirmer
    await iframe.locator("#rootForm\\:btnConfirmer").click();

    // Wait for declaration tabs
    await iframe.locator("a[href='#mainTab:tab3']").waitFor({ timeout: 30000 });
    log.info("Step 1 — Declaration opened, tabs loaded");
  }

  // ── STEP 2 — Entête Tab ──────────────────────────────────────────────────

  async _step2_entete(iframe, ach) {
    log.info("Step 2 — Filling Entête tab…");
    const page = this.page;

    // Expéditeur
    await iframe
      .locator("#mainTab\\:form0\\:nomOperateurExpediteur")
      .fill(ach.shipperName || "");

    // Poids brut total
    await this._fillClearType(
      iframe,
      "#mainTab\\:form0\\:poidBrutTotal_input",
      String(ach.poidTotal || ""),
    );

    // totalValue → montantTotal
    // If manifest currency is already USD, use totalValue as-is (no conversion).
    // Otherwise, convert via USD exchange rate.
    const manifestCurrency = (ach.currency || "").toUpperCase().trim();
    let montantTotal;
    if (manifestCurrency === "USD") {
      // Manifest is already in USD — use totalValue directly
      montantTotal = roundBADR(parseFloat(ach.totalValue || "0"));
      log.info(
        `Manifest currency is USD — using totalValue as-is: ${montantTotal}`,
      );
    } else {
      // Manifest is in another currency (e.g. MAD) — convert to USD via tauxChange
      let tauxChange = null;
      const tauxSpan = iframe.locator("#mainTab\\:form0\\:id_tauxChange");
      if (await tauxSpan.isVisible().catch(() => false)) {
        const tauxText = await tauxSpan.textContent().catch(() => "");
        const tauxNum = parseFloat(String(tauxText).replace(",", "."));
        if (tauxNum > 0) tauxChange = tauxNum;
      }
      if (!tauxChange) {
        try {
          tauxChange = await fetchMADRate("USD");
        } catch (e) {
          log.warn("Could not fetch USD rate — using fallback 10", e.message);
          tauxChange = 10;
        }
      }
      montantTotal = roundBADR(parseFloat(ach.totalValue || "0") / tauxChange);
      log.info(
        `Manifest currency is ${manifestCurrency || "unknown"} — converted via USD rate ${tauxChange}: ${montantTotal}`,
      );
    }
    await this._fillClearType(
      iframe,
      "#mainTab\\:form0\\:montTotalNumber_input",
      String(montantTotal),
    );

    // Date de voyage
    await this._fillInputIfVisible(
      iframe,
      "#mainTab\\:form0\\:dateVoyage_input",
      todayDDMMYYYY(),
    );
    await iframe
      .locator("#mainTab\\:form0\\:dateVoyage_input")
      .press("Tab")
      .catch(() => {});

    await this._sauvegarder(iframe);
    await page.waitForTimeout(1000);
    log.info("Step 2 — Entête saved");
  }

  // ── STEP 3 — Moyen de Transport Tab ─────────────────────────────────────

  async _step3_transport(iframe) {
    log.info("Step 3 — Filling Moyen de Transport tab…");
    await iframe.locator("a[href='#mainTab:tab11']").click();
    await iframe.locator("#mainTab\\:form11").waitFor({ timeout: 10000 });

    // Check "Sans moyen de transport"
    const chkBox = iframe
      .locator(
        "#mainTab\\:form11\\:checkBoxSansMTId .ui-chkbox-box, [id*='checkBoxSansMT'] .ui-chkbox-box",
      )
      .first();
    if (await chkBox.isVisible().catch(() => false)) {
      const isChecked = await chkBox
        .evaluate((el) => el.classList.contains("ui-state-active"))
        .catch(() => false);
      if (!isChecked) await chkBox.click();
    }

    await this._sauvegarder(iframe);
    await this.page.waitForTimeout(800);
    log.info("Step 3 — Transport saved");
  }

  // ── STEP 4 — Caution Tab ────────────────────────────────────────────────

  async _step4_caution(iframe) {
    log.info("Step 4 — Filling Caution tab…");
    await iframe.locator("a[href='#mainTab:tab2']").click();
    await iframe.locator("#mainTab\\:form2").waitFor({ timeout: 10000 });

    // Numéro décision selectonemenu
    const trigger = iframe
      .locator(
        "#mainTab\\:form2\\:numDecisionId .ui-selectonemenu-trigger, [id*='numDecision'] .ui-selectonemenu-trigger",
      )
      .first();
    if (await trigger.isVisible().catch(() => false)) {
      await trigger.click();
      await iframe
        .locator("li[data-label='S2021000002']")
        .waitFor({ state: "visible", timeout: 8000 });
      await iframe.locator("li[data-label='S2021000002']").click();
      await this.page.waitForTimeout(300);
    }

    await this._sauvegarder(iframe);
    await this.page.waitForTimeout(800);
    log.info("Step 4 — Caution saved");
  }

  // ── STEP 5 — Préapurement DS Tab ─────────────────────────────────────────

  async _step5_preapurement(iframe, ach) {
    log.info("Step 5 — Filling Préapurement DS tab…");
    await iframe.locator("a[href='#mainTab:tab3']").click();
    await iframe.locator("#mainTab\\:form3").waitFor({ timeout: 10000 });
    await this.page.waitForTimeout(500);

    const partiels = ach.partiels || [];
    const weightReadings = [];

    for (let i = 0; i < partiels.length; i++) {
      const p = partiels[i];
      log.info(`Step 5 — Adding lot ${i + 1}/${partiels.length}`, p);

      // Click Nouveau
      const nouveauBtn = iframe
        .locator(
          "button[name*='btnNouveauPreap'], button[id*='btnNouveauPreap']",
        )
        .first();
      await nouveauBtn.click();
      await this.page.waitForTimeout(500);

      // Type DS = DS(01)
      const typeTrigger = iframe
        .locator("[id*='typeDsId'] .ui-selectonemenu-trigger")
        .first();
      if (await typeTrigger.isVisible().catch(() => false)) {
        await typeTrigger.click();
        await iframe
          .locator("li[data-label='DS(01)']")
          .waitFor({ state: "visible", timeout: 5000 });
        await iframe.locator("li[data-label='DS(01)']").click();
        await this.page.waitForTimeout(200);
      }

      // Bureau
      await this._fillInputIfVisible(
        iframe,
        "input[id*='referencePreap_bureauId']",
        "301",
      );
      // Régime
      await this._fillInputIfVisible(
        iframe,
        "input[id*='referencePreap_regimeId']",
        "000",
      );
      // Année
      await this._fillInputIfVisible(
        iframe,
        "input[id*='referencePreap_anneeId']",
        "2026",
      );
      // Série
      await this._fillInputIfVisible(
        iframe,
        "input[id*='referencePreap_serieId']",
        p.serie,
      );
      // Clé
      await this._fillInputIfVisible(
        iframe,
        "input[id*='referencePreap_cleId']",
        p.cle,
      );

      // Lieu de chargement autocomplete
      const lieuInput = iframe
        .locator("input[id*='lieuChargCmb_INPUT_input']")
        .first();
      if (await lieuInput.isVisible().catch(() => false)) {
        await lieuInput.click();
        await lieuInput.pressSequentially(p.lieu || "", { delay: 80 });
        // Wait for the dropdown panel to appear, then pick the item whose
        // label contains p.lieu (avoids selecting a wrong airport code).
        const lieuItem = iframe
          .locator("li.ui-autocomplete-item")
          .filter({ hasText: p.lieu });
        await lieuItem.first().waitFor({ state: "visible", timeout: 10000 });
        await lieuItem.first().click();
        await this.page.waitForTimeout(400);
      }

      // Référence lot — strip scraped whitespace/ETAT lines, keep first line only
      const refClean = String(p.ref || "")
        .split(/[\r\n]/)[0]
        .trim();
      await this._fillInputIfVisible(
        iframe,
        "input[id*='preapurement_ref_lot']",
        refClean,
      );

      // Click OK
      const okBtn = iframe.locator("button[id*='btnRefPreapOk']").first();
      await okBtn.click();
      await this.page.waitForTimeout(2000);

      // Read poids + nbrContenant
      const poidsText = await iframe
        .locator("#mainTab\\:form3\\:poidLotId")
        .textContent()
        .catch(() => "");
      const nbrText = await iframe
        .locator("#mainTab\\:form3\\:nbrContenantLotId")
        .textContent()
        .catch(() => "");
      const poidsVal =
        parseFloat(
          String(poidsText)
            .replace(/[^\d.,]/g, "")
            .replace(",", "."),
        ) || 0;
      const nbrVal = parseInt(String(nbrText).replace(/[^\d]/g, ""), 10) || 0;
      weightReadings.push({ poids: poidsVal, nbr: nbrVal });
      log.info(
        `Step 5 — Lot ${i + 1} poids=${poidsVal} nbrContenant=${nbrVal}`,
      );

      // Confirmer
      const confirmerBtn = iframe
        .locator(
          "button#mainTab\\:form3\\:btnConfirmerPreap, button[id*='btnConfirmerPreap']",
        )
        .first();
      await confirmerBtn.click();
      await this.page.waitForTimeout(2000);
    }

    // ── Validate totals ──────────────────────────────────────────────────
    const totalPoids = weightReadings.reduce((s, r) => s + r.poids, 0);
    const totalNbr = weightReadings.reduce((s, r) => s + r.nbr, 0);
    const expectedPoids = parseFloat(
      String(ach.poidTotal || "0").replace(",", "."),
    );
    const expectedNbr = parseInt(String(ach.nombreContenant || "0"), 10);
    const poidsDiff = Math.abs(totalPoids - expectedPoids);

    if (poidsDiff > 1) {
      const msg = `Poids mismatch: sum of lots=${totalPoids.toFixed(2)} kg vs manifest=${expectedPoids} kg (diff=${poidsDiff.toFixed(2)} kg)`;
      log.error(msg);
      return { mismatch: true, errorMessage: msg, actualPoids: totalPoids };
    }
    if (expectedNbr > 0 && totalNbr !== expectedNbr) {
      log.warn(
        `NbrContenant mismatch: lots=${totalNbr} vs manifest=${expectedNbr}`,
      );
    }

    const poidsAdjusted = poidsDiff > 0;
    if (poidsAdjusted) {
      log.info(
        `Step 5 — Poids rounding correction: ${expectedPoids} → ${totalPoids.toFixed(2)} kg`,
      );
    }
    log.info("Step 5 — Préapurement complete, totals OK", {
      totalPoids,
      totalNbr,
    });
    return { mismatch: false, actualPoids: totalPoids, poidsAdjusted };
  }

  // ── STEP 6 (6) — Documents Tab ───────────────────────────────────────────

  async _step7_documents(iframe, ach) {
    log.info("Step 6 — Uploading documents…");
    await iframe.locator("a[href='#mainTab:tab7']").click();
    await iframe.locator("#mainTab\\:form7").waitFor({ timeout: 10000 });
    await this.page.waitForTimeout(500);

    // ── Document 1: FACTURE (manifest PDF) ──────────────────────────────
    await this._addDocument(iframe, ach, {
      typeLabel: "FACTURE",
      reference: "fac",
      pdfFilename: ach.manifeste,
      expectLabel: "FACTURE",
    });

    // ── Document 2: TITRE DE TRANSPORT (MAWB PDF) ────────────────────────
    await this._addDocument(iframe, ach, {
      typeLabel: "TITRE DE PROPRIÉTÉ ET/OU DE TRANSPORT",
      reference: "LTA",
      pdfFilename: ach.mawb,
      expectLabel: "TITRE DE PROPRIÉTÉ",
    });

    await this._sauvegarder(iframe);
    await this.page.waitForTimeout(1000);
    log.info("Step 6 — Documents saved");
  }

  async _addDocument(
    iframe,
    ach,
    { typeLabel, reference, pdfFilename, expectLabel },
  ) {
    if (!pdfFilename) {
      log.warn(`Skipping document ${typeLabel} — no PDF file`);
      return;
    }

    // Select type
    const typeTrigger = iframe
      .locator("#mainTab\\:form7\\:comp1 .ui-selectonemenu-trigger")
      .first();
    if (await typeTrigger.isVisible().catch(() => false)) {
      await typeTrigger.click();
      const typeItem = iframe.locator(`li[data-label="${typeLabel}"]`);
      await typeItem.waitFor({ state: "visible", timeout: 8000 });
      await typeItem.click();
      await this.page.waitForTimeout(300);
    }

    // Reference
    const refInput = iframe
      .locator("#mainTab\\:form7\\:j_id_3p_25r_2_2m_b, [id*='refAnnexe']")
      .first();
    if (await refInput.isVisible().catch(() => false)) {
      await refInput.fill(reference);
    }

    // Date — jQuery UI datepicker ignores .fill(); must click through calendar UI.
    // Click the trigger button → wait for picker → click today's highlighted cell.
    const calTrigger = iframe.locator(
      "#mainTab\\:form7\\:dateannexe .ui-datepicker-trigger",
    );
    await calTrigger
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => {});
    if (await calTrigger.isVisible().catch(() => false)) {
      await calTrigger.click();
      // Picker div is appended to iframe body by jQuery UI
      const calDiv = iframe.locator("#ui-datepicker-div");
      await calDiv.waitFor({ state: "visible", timeout: 5000 });
      // Click today's cell (has ui-datepicker-today class on the <td>)
      const todayCell = iframe.locator(
        "#ui-datepicker-div td.ui-datepicker-today a",
      );
      await todayCell.waitFor({ state: "visible", timeout: 3000 });
      await todayCell.click();
      await this.page.waitForTimeout(300);
    }

    // ── Compression cache ──────────────────────────────────────────────────
    // Short deterministic name (≤ 49 chars): <ref>_<sanitized-stem>.pdf
    // Saved to <LTA folder>/compress/ so the compression API is never called
    // twice for the same file (avoids quota waste on re-runs).
    const rawPath = path.join(ach.folderPath, pdfFilename);
    const ext = ".pdf";
    const originalStem = sanitizeFilename(
      path.basename(pdfFilename, path.extname(pdfFilename)),
    );
    const stem = `${reference}_${originalStem}`.slice(0, 45);
    const shortName = `${stem}${ext}`;
    const compressDir = path.join(ach.folderPath, "compress");
    const cachedPath = path.join(compressDir, shortName);

    let uploadPath;
    if (fs.existsSync(cachedPath) && isLikelyValidPdf(cachedPath)) {
      log.info(`Using cached compressed PDF: ${shortName}`);
      uploadPath = cachedPath;
    } else {
      if (!fs.existsSync(rawPath)) {
        log.warn(`Document file not found: ${rawPath}`);
        return;
      }
      if (!fs.existsSync(compressDir))
        fs.mkdirSync(compressDir, { recursive: true });
      const MAX_SIZE = 2 * 1024 * 1024;
      let sourcePath = rawPath;
      if (fs.statSync(rawPath).size > MAX_SIZE) {
        try {
          const result = await compressPdfForAnnex(rawPath, log);
          if (result && result.uploadPath && fs.existsSync(result.uploadPath))
            sourcePath = result.uploadPath;
        } catch (e) {
          log.warn(`PDF compression failed for ${pdfFilename}: ${e.message}`);
        }
      }
      fs.copyFileSync(sourcePath, cachedPath);
      uploadPath = cachedPath;
    }

    const fileInput = iframe
      .locator("#mainTab\\:form7\\:comp2_input, input[id*='annexeFile']")
      .first();
    await fileInput.setInputFiles(uploadPath);
    await this.page.waitForTimeout(2000);

    // Verify upload — waitFor retries until the row appears or times out
    const uploadedRow = iframe.locator(
      `#mainTab\\:form7\\:listFichiersAnnexeDT_data tr:has-text("${expectLabel}")`,
    );
    const uploaded = await uploadedRow
      .waitFor({ state: "visible", timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (!uploaded) {
      throw new Error(
        `Upload of ${typeLabel} did not appear in the document list`,
      );
    }
    log.info(`Document ${typeLabel} uploaded successfully`);
  }

  // ── STEP 7 (8) — Demandes Diverses Tab ──────────────────────────────────

  async _step8_demandes(iframe, ach) {
    log.info("Step 7 — Updating Demandes diverses…");
    await iframe.locator("a[href='#mainTab:tab4']").click();
    await iframe.locator("#mainTab\\:form4").waitFor({ timeout: 10000 });
    await this.page.waitForTimeout(500);

    // Click Autre(01) link
    const autreLink = iframe
      .locator(
        "a[id*='form4'][id*='j_id_3p_1km'][id*='j_id_3p_1ko'], #mainTab\\:form4 a:has-text('Autre')",
      )
      .first();
    await autreLink.click();

    // Wait for detail panel
    await iframe
      .locator("#mainTab\\:form4\\:dmd_details, [id*='dmd_details']")
      .waitFor({ timeout: 8000 });
    await this.page.waitForTimeout(300);

    // Edit the scellés textarea
    const textarea = iframe
      .locator("#mainTab\\:form4\\:j_id_3p_1ll, [id*='form4'] textarea")
      .first();
    if (await textarea.isVisible().catch(() => false)) {
      const current = await textarea.inputValue().catch(() => "");
      // Replace only the scellés numbers (everything after "Scellés N°")
      const prefix = current.replace(/Scell[eé]s\s+N°.*/i, "").trim();
      const newText = `${prefix} / Scellés N°${ach.scelle1}-${ach.scelle2}`;
      await textarea.fill(newText);
    }

    // Confirmer
    const confirmerBtn = iframe
      .locator(
        "button#mainTab\\:form4\\:btnConfirmerDmd, button[id*='btnConfirmerDmd']",
      )
      .first();
    await confirmerBtn.click();
    await this.page.waitForTimeout(800);

    await this._sauvegarder(iframe);
    await this.page.waitForTimeout(800);
    log.info("Step 7 — Demandes saved");
  }

  // ── STEP 8 (9) — Articles Tab ────────────────────────────────────────────

  async _step9_articles(iframe, ach) {
    log.info("Step 8 — Filling Articles tab…");
    await iframe.locator("a[href='#mainTab:tab1']").click();
    await iframe.locator("#mainTab\\:form1").waitFor({ timeout: 10000 });
    await this.page.waitForTimeout(500);

    // Click article "1" link
    const articleLink = iframe
      .locator(
        "a#mainTab\\:form1\\:j_id_3p_zn\\:0\\:cmdLinkEditArticle, #mainTab\\:form1 a[id*='cmdLinkEditArticle']",
      )
      .first();
    await articleLink.click();

    // Wait for article detail panel
    await iframe
      .locator(
        "#mainTab\\:form1\\:j_id_3p_10n, [id*='articleDetail'], [id*='article_panel']",
      )
      .waitFor({ timeout: 15000 });
    await this.page.waitForTimeout(500);

    // Nombre contenants
    await this._fillClearType(
      iframe,
      "#mainTab\\:form1\\:nbrContenantsId",
      String(ach.nombreContenant || ""),
    );

    // Marques
    await this._fillClearType(
      iframe,
      "#mainTab\\:form1\\:marqueContenants",
      `LTA ${ach.refNumber || ""}`.trim(),
    );

    // Poids net
    await this._fillClearType(
      iframe,
      "#mainTab\\:form1\\:poidNetNumber_input",
      String(ach.poidTotal || ""),
    );

    // Quantité normalisée
    await this._fillClearType(
      iframe,
      "#mainTab\\:form1\\:qteNormaliseeNumber_input",
      String(ach.poidTotal || ""),
    );

    // Quantité facturée
    await this._fillClearType(
      iframe,
      "#mainTab\\:form1\\:qteNumber_input",
      String(ach.qteFacturee || ""),
    );

    // Valeur déclarée = fretValueMAD + totalValue(MAD), rounded
    let valDec = 0;
    try {
      const rate = await fetchMADRate(ach.mawbCurrency || "USD");
      const fretMAD = parseFloat(ach.fretValue || "0") * rate;
      const manifVal = parseFloat(
        String(ach.totalValue || "0").replace(",", "."),
      );
      valDec = roundBADR(fretMAD + manifVal);
    } catch (e) {
      log.error("Exchange rate fetch failed for Articles tab:", e.message);
      throw e;
    }
    await this._fillClearType(
      iframe,
      "#mainTab\\:form1\\:valDecNumber_input",
      String(valDec),
    );

    // Confirmer
    const confirmerBtn = iframe
      .locator(
        "button#mainTab\\:form1\\:btnConfirmerArticle, button[id*='btnConfirmerArticle']",
      )
      .first();
    await confirmerBtn.click();
    await this.page.waitForTimeout(1000);

    await this._sauvegarder(iframe);
    await this.page.waitForTimeout(1000);
    log.info("Step 8 — Articles saved");
  }

  // ── STEP 9 (10) — Print ──────────────────────────────────────────────────

  async _step10_print(iframe, ach, updateState) {
    log.info("Step 9 — Reading declaration reference before print…");

    // Navigate to Entête tab so the reference table is in the DOM
    await iframe
      .locator("a[href='#mainTab:tab0']")
      .click()
      .catch(() => {});
    await this.page.waitForTimeout(600);

    const dumRefParts = await this._readDumRef(iframe);
    if (dumRefParts) {
      log.info(`Step 9 — DUM ref: ${dumRefParts.ref}`);
      updateState({ dumRef: dumRefParts.ref });
    }

    log.info("Step 9 — Printing declaration…");
    const printBtn = iframe.locator(
      "a#secure_imprimer, a[id='secure_imprimer']",
    );
    await printBtn.waitFor({ timeout: 15000 });

    const [download] = await Promise.all([
      this.page.waitForEvent("download", { timeout: 30000 }),
      printBtn.click(),
    ]);

    const refPart = dumRefParts ? `-${sanitizeFilename(dumRefParts.ref)}` : "";
    const safeName =
      sanitizeFilename(`${ach.name}-DUM-NORMAL-${ach.refNumber}`) + refPart;
    const destPath = path.join(ach.folderPath, `${safeName}.pdf`);
    await download.saveAs(destPath);
    log.info("Step 9 — PDF saved", { destPath });

    // Also copy to the system Downloads folder so the user can find it easily.
    try {
      const downloadsDir = path.join(os.homedir(), "Downloads");
      const downloadsCopy = path.join(downloadsDir, `${safeName}.pdf`);
      fs.copyFileSync(destPath, downloadsCopy);
      log.info("Step 9 — PDF copied to Downloads", { downloadsCopy });
    } catch (copyErr) {
      log.warn("Step 9 — Could not copy PDF to Downloads folder", {
        error: copyErr.message,
      });
    }

    return {
      destPath,
      serie: dumRefParts?.serie ?? null,
      cle: dumRefParts?.cle ?? null,
    };
  }

  /**
   * Read the assigned declaration reference from the Entête reference table.
   * Returns { ref: "2880 K", serie: "2880", cle: "K" }, or null if not found.
   * serie/cle are used by declarerScellesPartiel to fill the search form.
   */
  async _readDumRef(iframe) {
    try {
      const table = iframe.locator("#mainTab\\:form0\\:j_id_3p_d");
      await table.waitFor({ state: "visible", timeout: 5000 });
      const rows = table.locator("tbody tr");
      // Row 0 = headers (Bureau, Régime, Année, Série, Clé)
      // Row 1 = values
      const dataRow = rows.nth(1);
      const cells = dataRow.locator("td");
      const serie = (
        await cells
          .nth(3)
          .textContent()
          .catch(() => "")
      ).trim();
      const cle = (
        await cells
          .nth(4)
          .textContent()
          .catch(() => "")
      ).trim();
      if (!serie) return null;
      // Strip leading zeros from serie: "0002880" → "2880"
      const serieNum = String(parseInt(serie, 10) || serie);
      return {
        ref: cle ? `${serieNum} ${cle}` : serieNum,
        serie: serieNum,
        cle,
      };
    } catch {
      log.warn("Could not read DUM reference table — skipping");
      return null;
    }
  }

  // ── Shared helpers ───────────────────────────────────────────────────────

  // Re-fill Entête poids brut after Step 5 rounding correction.
  // Called only when actualPoids differs from manifest by ≤ 1 kg.
  async _correctEntePoids(iframe, poids) {
    log.info(`Correcting Entête poids brut → ${poids} kg…`);
    await iframe
      .locator("a[href='#mainTab:tab0']")
      .click()
      .catch(() => {});
    await iframe.locator("#mainTab\\:form0").waitFor({ timeout: 10000 });
    await this._fillClearType(
      iframe,
      "#mainTab\\:form0\\:poidBrutTotal_input",
      String(poids),
    );
    await this._sauvegarder(iframe);
    await this.page.waitForTimeout(500);
    log.info("Entête poids brut corrected");
  }

  async _sauvegarder(iframe) {
    const saveBtn = iframe.locator("a#secure__2002, a[id='secure__2002']");
    if (await saveBtn.isVisible().catch(() => false)) {
      await saveBtn.click();
      await this.page.waitForTimeout(1500);
    }
  }

  async _fillInputIfVisible(iframe, selector, value) {
    const selectors = selector.split(", ").map((s) => s.trim());
    for (const sel of selectors) {
      try {
        const el = iframe.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
          await el.fill(value);
          return;
        }
      } catch {
        // try next
      }
    }
  }

  async _fillClearType(iframe, selector, value) {
    const el = iframe.locator(selector).first();
    await el.click().catch(() => {});
    await el.selectText().catch(() => el.fill("").catch(() => {}));
    await el.fill(value);
  }
}

module.exports = BADRDumNormalPartiel;
module.exports.BadrSessionError = BadrSessionError;
