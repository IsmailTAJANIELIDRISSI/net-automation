const { createLogger } = require("../utils/logger");
const path = require("path");
const fs = require("fs");
const os = require("os");

const log = createLogger("BADRDsCombineFinalize");

class BADRDsCombineFinalize {
  constructor(page, tempDownloadDir, badrConn = null) {
    this.page = page;
    // Useful if we need an explicit path to save the PDF
    this.tempDownloadDir = tempDownloadDir;
    // Optional BADRConnection reference — used to reconnect if popup fails
    this.badrConn = badrConn;
  }

  /**
   * Finalize the procedure by:
   * 1. Downloading the Autorisation d'Entree PDF
   * 2. Declaring Scelles
   */
  async processFinalization(
    bureau,
    regime,
    serie,
    cle,
    scelle1,
    scelle2,
    ltaRank = "",
    lotReference = "",
  ) {
    const annee = new Date().getFullYear().toString();

    // PHASE 1: PDF Download
    const pdfPath = await this.downloadAutorisationEntree(
      bureau,
      regime,
      annee,
      serie,
      cle,
      ltaRank,
      lotReference,
    );

    // Simulate Emailing (will be implemented later)
    log.info(`Ready to email PDF from ${pdfPath} (Mailing feature pending...)`);

    // PHASE 2: Declare Scelles
    await this.declarerScelles(
      bureau,
      regime,
      annee,
      serie,
      cle,
      scelle1,
      scelle2,
    );

    return pdfPath;
  }

  // 1. Download Autorisation d'Entree
  async downloadAutorisationEntree(
    bureau,
    regime,
    annee,
    serie,
    cle,
    ltaRank = "",
    lotReference = "",
  ) {
    log.info(`Navigating to MISE EN DOUANE -> Déclaration to find the DS...`);
    const page = this.page;

    const expandMenuNode = async (anchorLocator, label) => {
      const nestedList = anchorLocator.locator(
        "xpath=following-sibling::ul[1]",
      );
      const isExpanded = await nestedList
        .evaluate((el) => window.getComputedStyle(el).display !== "none")
        .catch(() => false);

      if (!isExpanded) {
        log.info(`${label} collapsed – clicking to expand…`);
        await anchorLocator.click();
        await page.waitForTimeout(400);
      }
    };

    // Expand MISE EN DOUANE if collapsed
    const contentPanel = page.locator("#_150");
    const isVisible = await contentPanel.isVisible().catch(() => false);
    if (!isVisible) {
      log.info("MISE EN DOUANE collapsed – clicking header to expand…");
      await page
        .locator(".ui-panelmenu-header a")
        .filter({ hasText: "MISE EN DOUANE" })
        .click();
      await page.waitForSelector("#_150", { state: "visible", timeout: 10000 });
      await page.waitForTimeout(500);
    }

    // Expand Services -> Recherche par reference before clicking Déclaration
    const servicesLink = page.locator("a#_434").first();
    await servicesLink.waitFor({ state: "visible", timeout: 10000 });
    await expandMenuNode(servicesLink, "Services");

    const searchByRefLink = page.locator("a#_435").first();
    await searchByRefLink.waitFor({ state: "visible", timeout: 10000 });
    await expandMenuNode(searchByRefLink, "Recherche par reference");

    // Then click Déclaration
    const declarationLink = page
      .locator('a#_436, a[href*="med_rech_ref_dec.xhtml"]')
      .first();

    // Wait for the link to be visible + settle time for BADR menu animation
    await declarationLink.waitFor({ state: "visible", timeout: 10000 });
    await page.waitForTimeout(800);

    // Retry popup up to 3× with 20s each — avoids the outer 120s timeout on transient BADR UI flakiness
    let popup = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        [popup] = await Promise.all([
          page.waitForEvent("popup", { timeout: 20000 }),
          declarationLink.click(),
        ]);
        break;
      } catch {
        log.warn(
          `Déclaration popup attempt ${attempt}/3 failed – retrying click…`,
        );
        await page.waitForTimeout(1500);
      }
    }
    if (!popup) {
      // Popup never opened — BADR tab may have gone stale. Reconnect before outer retry.
      if (this.badrConn) {
        log.warn(
          "Déclaration popup failed — attempting BADR session reconnect…",
        );
        try {
          await this.badrConn.navigateToAccueil();
          log.info(
            "BADR session soft-reconnect (navigateToAccueil) succeeded.",
          );
        } catch {
          log.warn("navigateToAccueil failed — doing full BADR re-login…");
          await this.badrConn.navigateAndLogin();
          await this.badrConn.navigateToAccueil();
          log.info("BADR session full re-login succeeded.");
        }
        this.page = this.badrConn.page; // update page ref for subsequent steps
      }
      throw new Error(
        "Déclaration popup failed to open after 3 attempts (BADR reconnected — will retry)",
      );
    }

    await popup.waitForLoadState("domcontentloaded");
    log.info("Opened Déclaration search popup.");

    // Fill form in popup
    await popup.locator("input#form\\:medRechRefdecId_bureauId").fill(bureau);
    await popup.locator("input#form\\:medRechRefdecId_regimeId").fill(regime);
    await popup.locator("input#form\\:medRechRefdecId_anneeId").fill(annee);
    await popup.locator("input#form\\:medRechRefdecId_serieId").fill(serie);
    await popup.locator("input#form\\:medRechRefdecId_cleId").fill(cle);

    // Click Valider
    await popup.locator("button#form\\:btnConfirmer").click();

    // Wait for table to update.
    await popup.waitForSelector("div#form\\:ListelotdataTable", {
      state: "visible",
      timeout: 15000,
    });
    await popup.waitForTimeout(2000); // let animations settle

    log.info("Searching for MED AFRICA LOGISTICS row...");

    // We want to find the row with "MED AFRICA LOGISTICS" AND "DS MEAD combinee (AERIEN)"
    const tableBody = popup.locator("tbody#form\\:ListelotdataTable_data");
    const rows = tableBody.locator("tr.ui-widget-content");
    const count = await rows.count();

    let targetRow = null;
    let targetLink = null;

    for (let i = 0; i < count; i++) {
      const rowText = await rows.nth(i).innerText();
      if (
        rowText.includes("MED AFRICA LOGISTICS") &&
        rowText.includes("DS MEAD combinee")
      ) {
        targetRow = rows.nth(i);
        // find the link containing our ref
        targetLink = targetRow.locator("a.ui-commandlink").first();
        break;
      }
    }

    if (!targetLink) {
      log.error(
        "Could not find MED AFRICA LOGISTICS - DS MEAD combinee in the table.",
      );
      throw new Error("Row not found in Déclaration list for given reference");
    }

    log.info("Row found! Clicking declaration link...");

    // Click the link triggers another popup?
    // "what we do hereif we found this we click on the link ... to go to the declaration so when clicking a new popup appear"
    const [detailPopup] = await Promise.all([
      popup.waitForEvent("popup"),
      targetLink.click(),
    ]);

    await detailPopup.waitForLoadState("domcontentloaded");
    await detailPopup.waitForTimeout(2000);
    log.info("Opened Declaration détail popup.");

    // Expand Consultations with retry logic for render issues
    log.info("Expanding Consultations with retry logic...");
    const consultationsLink = detailPopup.locator(
      'a[tabindex="-1"]:has-text("Consultations")',
    );

    const imprimerButton = detailPopup.locator(
      "a#imprimerDSMeadCombineeAutorisationEntreeMarchandise",
    );

    let imprimerVisible = await imprimerButton.isVisible().catch(() => false);
    let retries = 0;
    const maxRetries = 3;

    while (!imprimerVisible && retries < maxRetries) {
      log.info(
        `Imprimer button not visible (retry ${retries + 1}/${maxRetries}). Expanding Consultations...`,
      );

      if (await consultationsLink.isVisible()) {
        await consultationsLink.click();
        await detailPopup.waitForTimeout(600);
      }

      imprimerVisible = await imprimerButton.isVisible().catch(() => false);
      retries++;
    }

    if (!imprimerVisible) {
      log.warn(
        "Imprimer button not found after retries. Attempting direct click anyway...",
      );
    }

    // Now click 'Imprimer autorisation entrée marchandise' and handle download
    log.info(
      "Clicking 'Imprimer autorisation entrée marchandise' and intercepting download...",
    );
    const [download] = await Promise.all([
      detailPopup.waitForEvent("download"),
      imprimerButton.click(),
    ]);

    // Rename PDF with LTA rank and lot reference if provided
    let pdfFileName = download.suggestedFilename(); // default: "DS_acheminement_entree_marchdandise.pdf"

    if (ltaRank && lotReference) {
      // Construct: DS_[rank]_acheminement_entree_marchandise_[lotReference].pdf
      pdfFileName = `DS_${ltaRank}_acheminement_entree_marchandise_${lotReference}.pdf`;
      log.info(`Using custom PDF name: ${pdfFileName}`);
    } else {
      log.info(`Downloading PDF with default name: ${pdfFileName}`);
    }

    const downloadPath = this.tempDownloadDir
      ? path.join(this.tempDownloadDir, pdfFileName)
      : path.join(__dirname, "..", "..", "temp", pdfFileName);

    // ensure dir exists
    const dir = path.dirname(downloadPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await download.saveAs(downloadPath);
    log.info(`PDF successfully saved to ${downloadPath}`);

    // Also save to system Downloads folder
    const systemDownloadsDir = path.join(os.homedir(), "Downloads");
    if (!fs.existsSync(systemDownloadsDir)) {
      fs.mkdirSync(systemDownloadsDir, { recursive: true });
    }
    const systemDownloadPath = path.join(systemDownloadsDir, pdfFileName);
    fs.copyFileSync(downloadPath, systemDownloadPath);
    log.info(`PDF also saved to system Downloads: ${systemDownloadPath}`);

    // Close popups
    await detailPopup.close().catch(() => {});
    await popup.close().catch(() => {});

    return downloadPath;
  }

  // 2. Declare Scelles
  async declarerScelles(bureau, regime, annee, serie, cle, scelle1, scelle2) {
    const page = this.page;
    if (!scelle1 || !scelle2) {
      log.warn(
        "Scellé 1 or Scellé 2 is missing. Skipping Scellés declaration.",
      );
      return;
    }

    log.info("Restarting with DEDOUANEMENT to declare Scellés...");

    // Go back to main BADR window
    await page.bringToFront();

    // Expand "DEDOUANEMENT"
    const dedouanementPanel = page.locator(
      'h3.ui-panelmenu-header:has-text("DEDOUANEMENT")',
    );
    const isExpanded =
      (await dedouanementPanel.getAttribute("aria-expanded")) === "true";
    if (!isExpanded) {
      log.info("Clicking DEDOUANEMENT to expand...");
      await dedouanementPanel.click();
      await page.waitForTimeout(500);
    }

    // Expand "DS MEAD COMBINEE" using a deterministic selector to avoid strict-mode collisions.
    log.info("Expanding DS MEAD COMBINEE...");
    const dsMeadCombineeNode = page
      .locator(
        'a#_205151, a.ui-menuitem-link:has(span.ui-menuitem-text:text-is("DS MEAD COMBINEE"))',
      )
      .first();
    await dsMeadCombineeNode.waitFor({ state: "visible", timeout: 15000 });
    await dsMeadCombineeNode.click();
    await page.waitForTimeout(500);

    // Click "Déclarer scellés DS MEAD combinée"
    log.info("Clicking Déclarer scellés..."); // Handle UTF-8 safely
    const declarerLink = page
      .locator(
        'a#_12251, a[title*="codeFonctionnalite=cf12251"], a[href*="dsMeadCombineeScelle.xhtml"]',
      )
      .first();
    await declarerLink.waitFor({ state: "visible", timeout: 15000 });
    await declarerLink.click();

    const resolveVisibleLocator = async (
      contexts,
      selectors,
      timeoutMs = 20000,
    ) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (const ctx of contexts) {
          for (const selector of selectors) {
            const candidate = ctx.locator(selector).first();
            const visible = await candidate.isVisible().catch(() => false);
            if (visible) {
              return { ctx, locator: candidate, selector };
            }
          }
        }
        await page.waitForTimeout(300);
      }

      throw new Error(
        `Scellés form not visible after clicking Déclarer scellés. Tried selectors: ${selectors.join(", ")}`,
      );
    };

    const contexts = [page, ...page.frames()];

    // Wait for form to load (main page or iframe, flexible IDs)
    const bureauField = await resolveVisibleLocator(contexts, [
      "input#rootForm\\:_bureauId",
      "input[id$=':_bureauId']",
      "input[id$=':bureauId']",
    ]);
    const formCtx = bureauField.ctx;

    // Fill search criteria
    await bureauField.locator.fill(bureau);
    await formCtx
      .locator(
        "input#rootForm\\:_regimeId, input[id$=':_regimeId'], input[id$=':regimeId']",
      )
      .first()
      .fill(regime);
    await formCtx
      .locator(
        "input#rootForm\\:_anneeId, input[id$=':_anneeId'], input[id$=':anneeId']",
      )
      .first()
      .fill(annee);
    await formCtx
      .locator(
        "input#rootForm\\:_serieId, input[id$=':_serieId'], input[id$=':serieId']",
      )
      .first()
      .fill(serie);
    await formCtx
      .locator(
        "input#rootForm\\:_cleId, input[id$=':_cleId'], input[id$=':cleId']",
      )
      .first()
      .fill(cle);

    log.info("Validating reference...");
    await formCtx
      .locator("button#rootForm\\:btnConfirmer, button[id$=':btnConfirmer']")
      .first()
      .click();

    // Wait for the Scellés section to appear (wait for #eciMain\:scelle1)
    await resolveVisibleLocator(
      [formCtx, page, ...page.frames()],
      ["input#eciMain\\:scelle1", "input[id$=':scelle1']"],
    );
    await page.waitForTimeout(1000);

    log.info("Scellés input form ready. Filling numeric data...");

    // Calculate prince number. "06+07" (last two digits)
    const p1 = scelle1.slice(-2);
    const p2 = scelle2.slice(-2);
    const princeStr = `${p1}-${p2}`;

    // Fill "Numéro Pince" and "Nombre de Scellés".
    // BADR markup uses <td> text cells (not <label>), with dynamic input ids.
    const pinceInputLocator = formCtx
      .locator(
        'xpath=//tr[td[contains(normalize-space(.),"Numéro Pince")]]/td[contains(normalize-space(.),"Numéro Pince")]/following-sibling::td[1]//input[@type="text"]',
      )
      .first();
    await pinceInputLocator.waitFor({ state: "visible", timeout: 15000 });
    await pinceInputLocator.fill(princeStr);

    const nombreInputLocator = formCtx
      .locator(
        'xpath=//tr[td[contains(normalize-space(.),"Nombre de Scellés")]]/td[contains(normalize-space(.),"Nombre de Scellés")]/following-sibling::td[1]//input[@type="text"]',
      )
      .first();
    await nombreInputLocator.waitFor({ state: "visible", timeout: 15000 });
    await nombreInputLocator.fill("2");

    log.info(`Adding Scellé 1: ${scelle1}`);
    await formCtx
      .locator("input#eciMain\\:scelle1, input[id$=':scelle1']")
      .first()
      .fill(scelle1);
    await formCtx
      .locator("button#eciMain\\:btn_add_pince1, button[id$=':btn_add_pince1']")
      .first()
      .click();
    await page.waitForTimeout(1000);

    // PrimeFaces updates the whole panel after each "+" click; re-apply the value.
    await formCtx
      .locator(
        'xpath=//tr[td[contains(normalize-space(.),"Nombre de Scellés")]]/td[contains(normalize-space(.),"Nombre de Scellés")]/following-sibling::td[1]//input[@type="text"]',
      )
      .first()
      .fill("2");

    log.info(`Adding Scellé 2: ${scelle2}`);
    await formCtx
      .locator("input#eciMain\\:scelle1, input[id$=':scelle1']")
      .first()
      .fill(""); // Clear first
    await formCtx
      .locator("input#eciMain\\:scelle1, input[id$=':scelle1']")
      .first()
      .fill(scelle2);
    await formCtx
      .locator("button#eciMain\\:btn_add_pince1, button[id$=':btn_add_pince1']")
      .first()
      .click();
    await page.waitForTimeout(1000);

    // Re-apply once more after second panel refresh to ensure final validation passes.
    await formCtx
      .locator(
        'xpath=//tr[td[contains(normalize-space(.),"Nombre de Scellés")]]/td[contains(normalize-space(.),"Nombre de Scellés")]/following-sibling::td[1]//input[@type="text"]',
      )
      .first()
      .fill("2");

    // Verify list contains 2 items
    const listCount = await formCtx
      .locator(
        "#eciMain\\:listPinces1_input option, select[id$=':listPinces1_input'] option",
      )
      .count();
    if (listCount !== 2) {
      log.warn(
        `Expected 2 scelles in list, found ${listCount}. Ensure they were not duplicates or rejected.`,
      );
    }

    log.info("Clicking final CONFIRMER for Scellés...");
    // A tag with id="secure_10", fallback to text if id is dynamic
    const btnConfirmer = formCtx
      .locator('a#secure_10, a:has-text("Confirmer")')
      .first();
    await btnConfirmer.click();

    // Check for success message
    await formCtx
      .waitForSelector("#form1\\:messages", {
        state: "visible",
        timeout: 20000,
      })
      .catch(() => log.warn("Timeout waiting for message box."));

    const msgBlock = await formCtx
      .locator("#form1\\:messages")
      .innerText()
      .catch(() => "");
    if (msgBlock.includes("Opération effectuée avec succès")) {
      log.info("SUCCESS: Opération effectuée avec succès (Scellés declared)!");
    } else {
      log.error(
        `Possible error in Scellés declaration. Message Box Text:\n${msgBlock}`,
      );
      throw new Error("Scellés declaration failed. Check log.");
    }

    // Cleanup: close any remaining popups from the scellés form
    const allPages = page.context().pages();
    for (const p of allPages) {
      if (p !== page && !p.isClosed()) {
        log.info("Closing scellés form popup after finalization");
        await p.close().catch(() => {});
      }
    }

    // Bring main page back to front and stabilize
    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(500);
  }
}

module.exports = BADRDsCombineFinalize;
