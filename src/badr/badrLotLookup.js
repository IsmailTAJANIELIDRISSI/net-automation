"use strict";
/**
 * BADRLotLookup – navigates the BADR left menu to open the
 * "Lot de dédouanement" popup, fills the search form, and returns:
 *
 *   {
 *     declarationRef:  '301-000-2026-0003064-A',
 *     serie:           '0003064',
 *     cle:             'A',
 *     sequenceNum:     '0003064',
 *     lieuChargement:  'ABOU DHABI INT',
 *     rowCount:        1,        // 1 = DS Combiné, 2+ = Partiel (skip)
 *     isPartiel:       false,
 *     isEmpty:         false,    // true → 0 results → email sent
 *   }
 *
 * Menu path: MISE EN DOUANE → Services (#_434) → Recherche par reference (#_435)
 *            → Lot de dédouanement (#_437)  [opens new popup window]
 */

const nodemailer = require("nodemailer");
const config = require("../config/config");
const { createLogger } = require("../utils/logger");

const log = createLogger("BADRLotLookup");

const FORM = "j_id_1h"; // stable form id on the popup page

class BADRLotLookup {
  /**
   * @param {import('playwright').Page} page – The BADR main page (already logged in)
   */
  constructor(page) {
    this.page = page;
    this.popupPage = null;
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  STEP 1 – Open the popup via the left menu
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Navigate: MISE EN DOUANE → Services → Recherche par reference
   *           → Lot de dédouanement → popup
   */
  async openLotPopup() {
    const page = this.page;
    log.info("Opening Lot de dédouanement popup…");

    // 1a. Ensure MISE EN DOUANE panel is expanded.
    // Reliable signal: h3 has 'ui-state-active' when expanded, not when collapsed.
    // (Checking #_150 visibility is unreliable — BADR may have it in DOM but hidden mid-animation.)
    const miseEnDouaneHeader = page
      .locator(".ui-panelmenu-header")
      .filter({ hasText: "MISE EN DOUANE" });
    const isExpanded = await miseEnDouaneHeader
      .evaluate((el) => el.classList.contains("ui-state-active"))
      .catch(() => false);

    if (!isExpanded) {
      log.info("MISE EN DOUANE collapsed – clicking header to expand…");
      await miseEnDouaneHeader.locator("a").click();
      await page.waitForSelector("#_150", { state: "visible", timeout: 10000 });
      await page.waitForTimeout(500);
    } else {
      log.info("MISE EN DOUANE already expanded");
    }

    // 1b. Ensure Services (#_434) and then Recherche par reference (#_435) are expanded
    //     so that #_437 (Lot de dédouanement) becomes visible
    const lotItem = page.locator("#_437");
    const lotVisible = await lotItem.isVisible().catch(() => false);

    if (!lotVisible) {
      log.info("Services submenu not visible – clicking #_434 to expand…");
      await page.click("#_434");
      await page.waitForTimeout(500);

      const lotVisible2 = await page
        .locator("#_437")
        .isVisible()
        .catch(() => false);
      if (!lotVisible2) {
        log.info("Recherche par reference still hidden – clicking #_435…");
        await page.click("#_435");
        await page.waitForTimeout(400);
      }
    }

    // 1c. Wait until #_437 is clickable then open popup
    await page.waitForSelector("#_437", { state: "visible", timeout: 10000 });
    log.info('Clicking "Lot de dédouanement" – waiting for popup window…');

    const [newPage] = await Promise.all([
      page.context().waitForEvent("page", { timeout: 30000 }),
      page.click("#_437"),
    ]);

    await newPage.waitForLoadState("domcontentloaded");
    this.popupPage = newPage;
    log.info("Lot de dédouanement popup opened");
    return newPage;
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  STEP 2 – Fill the search form and return parsed results
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Fill all required fields and submit.
   * @param {string} lotReference – MAWB number, e.g. "607-52839835"
   */
  async searchLot(lotReference) {
    const p = this.popupPage;
    const normalizedLotReference = this._normalizeLotReference(lotReference);

    // Default behavior: try the last 6 days once.
    // If we get 0 results, retry using the previous 6-day window (shift earlier).
    // This avoids failing the workflow during testing when BADR data isn't ready yet.
    const windowDays = Number(process.env.BADR_SEARCH_WINDOW_DAYS || 6);
    const retryAttempts = Number(process.env.BADR_SEARCH_RETRY_ATTEMPTS || 2);
    const retryShiftDays = Number(
      process.env.BADR_SEARCH_RETRY_SHIFT_DAYS || windowDays,
    );

    let lastResult = null;

    const retryStartExtraDays = Number(
      process.env.BADR_SEARCH_RETRY_START_EXTRA_DAYS || 1,
    );

    for (let attempt = 0; attempt < retryAttempts; attempt++) {
      const endOffsetDays = -attempt * retryShiftDays;
      const { dateDu, dateAu } = this._computeDateRange(
        endOffsetDays,
        windowDays,
        attempt === 0 ? 0 : retryStartExtraDays,
      );

      log.info("Filling lot search form", {
        attempt: attempt + 1,
        retryAttempts,
        lotReference,
        normalizedLotReference,
        dateDu,
        dateAu,
      });

      if (attempt === 0) {
        // ── Référence du Lot ───────────────────────────────────────────────
        await p.fill(`#${FORM}\\:j_id_1p`, normalizedLotReference);

        // ── Bureau autocomplete: type "301" → select CASA/NOUASSER-FRET(301)
        // Must use pressSequentially (not fill) so PrimeFaces keydown handlers fire
        const bureauInput = p.locator(`#${FORM}\\:burCmbId_INPUT_input`);
        await bureauInput.click();
        await bureauInput.pressSequentially("301", { delay: 100 });
        await p.waitForSelector(
          `#${FORM}\\:burCmbId_INPUT_panel li.ui-autocomplete-item`,
          { state: "visible", timeout: 15000 },
        );
        await p
          .locator(`#${FORM}\\:burCmbId_INPUT_panel li.ui-autocomplete-item`)
          .first()
          .click();
        await p.waitForTimeout(300);
        log.info('Bureau "301" selected');

        // ── Opérateur autocomplete: type "cie national" → select RAM
        const opInput = p.locator(`#${FORM}\\:operateurCmbId_INPUT_input`);
        await opInput.click();
        await opInput.pressSequentially("cie national", { delay: 80 });
        await p.waitForSelector(
          `#${FORM}\\:operateurCmbId_INPUT_panel li.ui-autocomplete-item`,
          { state: "visible", timeout: 15000 },
        );
        await p
          .locator(
            `#${FORM}\\:operateurCmbId_INPUT_panel li.ui-autocomplete-item`,
          )
          .first()
          .click();
        await p.waitForTimeout(300);
        log.info('Opérateur "CIE NATIONALE ROYAL AIR MAROC" selected');

        // ── Type de déclaration: DS(01)
        await p.click(`#${FORM}\\:j_id_30 .ui-selectonemenu-trigger`);
        await p.waitForSelector('li[data-label="DS(01)"]', {
          state: "visible",
          timeout: 5000,
        });
        await p.click('li[data-label="DS(01)"]');
        log.info("Type déclaration = DS(01)");

        // ── Mode de transport: AERIEN(02)
        await p.click(`#${FORM}\\:j_id_36 .ui-selectonemenu-trigger`);
        await p.waitForSelector('li[data-label="AERIEN(02)"]', {
          state: "visible",
          timeout: 5000,
        });
        await p.click('li[data-label="AERIEN(02)"]');
        log.info("Mode transport = AERIEN(02)");
      }

      // ── Période voyage: du → au (always update per attempt) ─────────────
      await p.fill(`#${FORM}\\:j_id_1v_input`, dateDu);
      await p.press(`#${FORM}\\:j_id_1v_input`, "Tab");
      await p.fill(`#${FORM}\\:j_id_1z_input`, dateAu);
      await p.press(`#${FORM}\\:j_id_1z_input`, "Tab");

      // ── Submit ───────────────────────────────────────────────────────────
      log.info("Clicking Valider…");
      await p.click(`#${FORM}\\:confirmButon`);

      // Wait for PrimeFaces partial update: result panel must contain the count text
      await p.waitForFunction(
        () => {
          const panel = document.getElementById("j_id_1h:resultPanel");
          return (
            panel && panel.textContent.includes("Nombre d'enregistrements")
          );
        },
        { timeout: 30000 },
      );
      await p.waitForTimeout(500);

      const isFinalAttempt = attempt === retryAttempts - 1;
      lastResult = await this._parseResults(normalizedLotReference, {
        sendNoResultEmail: isFinalAttempt,
      });

      if (!lastResult?.isEmpty) return lastResult;

      if (!isFinalAttempt) {
        log.warn(
          `No result yet — retrying earlier window (attempt ${attempt + 2}/${retryAttempts})…`,
        );
      }
    }

    return lastResult;
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  STEP 3 – Parse the result table
  // ────────────────────────────────────────────────────────────────────────────

  async _parseResults(lotReference, { sendNoResultEmail = true } = {}) {
    const p = this.popupPage;

    const headerText = await p
      .locator(".ui-datatable-header")
      .textContent()
      .catch(() => "");
    const matchCount = headerText.match(/:\s*(\d+)/);
    const rowCount = matchCount ? parseInt(matchCount[1], 10) : 0;

    log.info(`Search returned ${rowCount} row(s)`);

    // ── 0 results → send email → return empty flag ────────────────────────────
    if (rowCount === 0) {
      if (sendNoResultEmail) {
        log.warn(`No lot found for "${lotReference}" – notifying by email`);
        await this._sendNoResultEmail(lotReference);
      } else {
        log.info(
          `No lot found for "${lotReference}" — email deferred until final attempt`,
        );
      }
      return { isEmpty: true, isPartiel: false, rowCount: 0, lotReference };
    }

    // ── 2+ results → DS Partiel → caller must skip ────────────────────────────
    if (rowCount >= 2) {
      log.warn(`${rowCount} rows → DS Partiel detected – skipping`);
      return { isEmpty: false, isPartiel: true, rowCount, lotReference };
    }

    // ── 1 result → DS Combiné ─────────────────────────────────────────────────
    const firstRow = p.locator("#j_id_1h\\:ListelotdataTable tbody tr").first();
    const cells = firstRow.locator("td");

    // td[1] = Lieu de (dé)chargement
    const lieuChargement = (await cells.nth(1).textContent()).trim();

    // td[2] = Déclaration link + statut
    const declarationRef = (
      await cells.nth(2).locator("a").first().textContent()
    ).trim();
    const cellText = await cells.nth(2).textContent();
    const statutMatch = cellText.match(/Statut\s*:\s*(\S+)/);
    const statut = statutMatch ? statutMatch[1].trim() : "";

    // Parse "301-000-2026-0003064-A"
    const parts = declarationRef.split("-");
    const bureau = parts[0];
    const regime = parts[1];
    const annee = parts[2];
    const serie = parts[3]; // '0003064'
    const cle = parts[4]; // 'A'

    const result = {
      declarationRef,
      bureau,
      regime,
      annee,
      serie,
      cle,
      sequenceNum: serie,
      lieuChargement,
      statut,
      rowCount: 1,
      isPartiel: false,
      isEmpty: false,
      lotReference,
    };

    log.info("Lot parsed successfully", result);
    return result;
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Helpers
  // ────────────────────────────────────────────────────────────────────────────

  /** Returns { dateDu, dateAu } as DD/MM/YYYY. dateAu = today, dateDu = today-6. */
  _normalizeLotReference(lotReference) {
    const ref = String(lotReference || "").trim();
    const match = ref.match(/^(0+)(\d+)(-.+)$/);

    if (!match) return ref;

    const normalizedPrefix = String(parseInt(match[2], 10));
    return `${normalizedPrefix}${match[3]}`;
  }

  _computeDateRange(endOffsetDays = 0, windowDays = 6, startExtraDays = 0) {
    const now = new Date();
    const dateAu = new Date(now);
    dateAu.setDate(now.getDate() + endOffsetDays);

    const dateDu = new Date(dateAu);
    dateDu.setDate(dateAu.getDate() - windowDays - startExtraDays);

    const fmt = (d) => {
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const yyyy = d.getFullYear();
      return `${dd}/${mm}/${yyyy}`;
    };

    return { dateDu: fmt(dateDu), dateAu: fmt(dateAu) };
  }

  /** Send email notification when no result found ("Pas encours manifest"). */
  async _sendNoResultEmail(lotReference) {
    const { email } = config;
    if (!email.enabled || !email.user || !email.to) {
      log.warn("Email notification skipped (EMAIL_ENABLED not set in .env)");
      return;
    }
    try {
      const transporter = nodemailer.createTransport({
        host: email.host,
        port: email.port,
        secure: email.port === 465,
        auth: { user: email.user, pass: email.pass },
      });

      const today = new Date().toLocaleDateString("fr-FR");
      await transporter.sendMail({
        from: email.from || email.user,
        to: email.to,
        subject: `[BADR] Pas encours manifest – ${lotReference}`,
        text: [
          `Bonjour,`,
          ``,
          `La référence suivante n'a pas encore de séquence disponible dans BADR :`,
          ``,
          `  Référence LTA : ${lotReference}`,
          `  Date de recherche : ${today}`,
          ``,
          `Merci de vérifier manuellement ou de relancer l'automatisation ultérieurement.`,
          ``,
          `-- MedAfrica DS Combinée Automation`,
        ].join("\n"),
      });
      log.info(`Email notification sent for "${lotReference}"`);
    } catch (err) {
      log.error("Email send failed", { message: err.message });
    }
  }

  /** Close the popup page. */
  async close() {
    if (this.popupPage && !this.popupPage.isClosed()) {
      await this.popupPage.close();
      this.popupPage = null;
    }
  }
}

module.exports = BADRLotLookup;
