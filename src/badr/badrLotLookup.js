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
    // Most reliable signal: #_150 aria-hidden="false" when expanded, "true" when collapsed.
    // (Checking header classes or visibility is flaky — ui-helper-hidden is present in both states.)
    const isMiseEnDouaneExpanded = () =>
      page
        .locator("#_150")
        .evaluate((el) => el.getAttribute("aria-hidden") === "false")
        .catch(() => false);

    if (!(await isMiseEnDouaneExpanded())) {
      log.info("MISE EN DOUANE collapsed – clicking header to expand…");
      await page
        .locator(".ui-panelmenu-header")
        .filter({ hasText: "MISE EN DOUANE" })
        .locator("a")
        .click();
      // Wait for aria-hidden to flip to "false" — not for visibility (ui-helper-hidden stays)
      await page.waitForFunction(
        () =>
          document.querySelector("#_150")?.getAttribute("aria-hidden") ===
          "false",
        { timeout: 10000 },
      );
      await page.waitForTimeout(300);
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
    await page.waitForSelector("#_437", { state: "visible", timeout: 20000 });
    log.info('Clicking "Lot de dédouanement" – waiting for popup window…');

    const [newPage] = await Promise.all([
      page.context().waitForEvent("page", { timeout: 60000 }),
      page.click("#_437"),
    ]);

    // Wait for HTML to be parsed, then for the network to settle (slow connections).
    await newPage.waitForLoadState("domcontentloaded");
    await newPage
      .waitForLoadState("networkidle", { timeout: 30_000 })
      .catch(() =>
        log.warn(
          "Popup networkidle timed-out – waiting for form input instead",
        ),
      );

    // Final guard: the lot-reference input must exist before we try to fill it.
    await newPage
      .waitForSelector(`#${FORM}\\:j_id_1p`, {
        state: "visible",
        timeout: 30_000,
      })
      .catch(async () => {
        log.warn("Form input not visible after 30 s – reloading popup page…");
        await newPage.reload({ waitUntil: "domcontentloaded" });
        await newPage.waitForSelector(`#${FORM}\\:j_id_1p`, {
          state: "visible",
          timeout: 30_000,
        });
      });

    this.popupPage = newPage;
    log.info("Lot de dédouanement popup opened and form ready");
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

    const retryStartExtraDays = Number(
      process.env.BADR_SEARCH_RETRY_START_EXTRA_DAYS || 1,
    );

    // Opérateurs essayés dans l'ordre : RAM d'abord, puis SWIFTAIR en secours
    // si RAM ne donne aucun lot sur toutes les fenêtres de dates.
    const operateurs = [
      { query: "cie national", label: "CIE NATIONALE ROYAL AIR MAROC" },
      { query: "swiftair maroc", label: "SWIFTAIR MAROC" },
    ];

    // ── Champs statiques (indépendants de l'opérateur) — remplis une seule fois ──
    await p.fill(`#${FORM}\\:j_id_1p`, normalizedLotReference);

    // Bureau autocomplete: "301" → CASA/NOUASSER-FRET(301). pressSequentially
    // (not fill) so PrimeFaces keydown handlers fire.
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

    // Type de déclaration: DS(01)
    await p.click(`#${FORM}\\:j_id_30 .ui-selectonemenu-trigger`);
    await p.waitForSelector('li[data-label="DS(01)"]', {
      state: "visible",
      timeout: 5000,
    });
    await p.click('li[data-label="DS(01)"]');
    log.info("Type déclaration = DS(01)");

    // Mode de transport: AERIEN(02)
    await p.click(`#${FORM}\\:j_id_36 .ui-selectonemenu-trigger`);
    await p.waitForSelector('li[data-label="AERIEN(02)"]', {
      state: "visible",
      timeout: 5000,
    });
    await p.click('li[data-label="AERIEN(02)"]');
    log.info("Mode transport = AERIEN(02)");

    let lastResult = null;

    for (let opIdx = 0; opIdx < operateurs.length; opIdx++) {
      const op = operateurs[opIdx];
      const isLastOperateur = opIdx === operateurs.length - 1;

      await this._selectOperateur(op.query, op.label);

      for (let attempt = 0; attempt < retryAttempts; attempt++) {
        const endOffsetDays = -attempt * retryShiftDays;
        const { dateDu, dateAu } = this._computeDateRange(
          endOffsetDays,
          windowDays,
          attempt === 0 ? 0 : retryStartExtraDays,
        );

        log.info("Filling lot search form", {
          operateur: op.label,
          attempt: attempt + 1,
          retryAttempts,
          lotReference,
          normalizedLotReference,
          dateDu,
          dateAu,
        });

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
        // Only send the "no result" email on the very last try (last window of
        // the last opérateur) — otherwise we'd email before trying SWIFTAIR.
        lastResult = await this._parseResults(normalizedLotReference, {
          sendNoResultEmail: isFinalAttempt && isLastOperateur,
        });

        if (!lastResult?.isEmpty) return lastResult;

        if (!isFinalAttempt) {
          log.warn(
            `No result yet — retrying earlier window (attempt ${attempt + 2}/${retryAttempts})…`,
          );
        }
      }

      if (!isLastOperateur) {
        log.warn(
          `Aucun lot pour opérateur "${op.label}" — essai avec "${operateurs[opIdx + 1].label}"…`,
        );
      }
    }

    return lastResult;
  }

  /** Select an opérateur in the lot-search autocomplete (clears any previous value). */
  async _selectOperateur(query, label) {
    const p = this.popupPage;
    const opInput = p.locator(`#${FORM}\\:operateurCmbId_INPUT_input`);
    await opInput.click();
    await opInput.fill(""); // clear any previously selected opérateur
    await opInput.pressSequentially(query, { delay: 80 });
    await p.waitForSelector(
      `#${FORM}\\:operateurCmbId_INPUT_panel li.ui-autocomplete-item`,
      { state: "visible", timeout: 15000 },
    );
    await p
      .locator(`#${FORM}\\:operateurCmbId_INPUT_panel li.ui-autocomplete-item`)
      .first()
      .click();
    await p.waitForTimeout(300);
    log.info(`Opérateur "${label}" selected`);
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

    // ── 2+ results → DS Partiel → collect all rows ────────────────────────────
    if (rowCount >= 2) {
      log.info(`${rowCount} rows → DS Partiel — collecting all lots`);
      const partiels = [];
      const rows = p.locator("#j_id_1h\\:ListelotdataTable tbody tr");
      const count = await rows.count();
      for (let i = 0; i < count; i++) {
        const cells = rows.nth(i).locator("td");
        const lieu = (
          await cells
            .nth(1)
            .textContent()
            .catch(() => "")
        ).trim();
        const refText = (
          await cells
            .nth(2)
            .locator("a")
            .first()
            .textContent()
            .catch(() => "")
        ).trim();
        const ref = (
          await cells
            .nth(0)
            .textContent()
            .catch(() => "")
        ).trim();
        // Parse "301-000-2026-0005406-X" → serie="5406", cle="X"
        const rParts = refText.split("-");
        const rawSerie = rParts[3] || "";
        const cle = rParts[4] || "";
        const serie = String(parseInt(rawSerie, 10) || rawSerie);
        partiels.push({ serie, cle, lieu, ref });
      }
      log.info("Partiel lots collected", partiels);
      return {
        isEmpty: false,
        isPartiel: true,
        rowCount,
        lotReference,
        partiels,
      };
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

  /** Send email notification when no result found ("Pas encore manifest"). */
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
        subject: `[BADR] Pas encore manifest – ${lotReference}`,
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
          `-- MedAfrica DS Combinée --`,
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
