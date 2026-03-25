"use strict";
/**
 * BADRConnection – launches Edge with remote debugging via child_process,
 * then connects Playwright over CDP.
 *
 * Mirrors the Python BADRConnection class from the original reference code
 * but uses Playwright's chromium.connectOverCDP instead of Selenium.
 */

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const config = require("../config/config");
const { createLogger } = require("../utils/logger");

const log = createLogger("BADRConnection");

class BADRConnection {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.edgeProcess = null;
  }

  /**
   * Spawn a fresh Edge instance with remote debugging enabled.
   * Mirrors Python's start_fresh_edge().
   */
  async startFreshEdge() {
    const { edgePath, debuggingPort, userDataDir } = config.badr;

    // Ensure profile dir exists
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
      log.info(`Created Edge profile dir: ${userDataDir}`);
    }

    log.info(`Launching Edge on port ${debuggingPort}...`);

    this.edgeProcess = spawn(
      edgePath,
      [
        `--remote-debugging-port=${debuggingPort}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-popup-blocking",
      ],
      { detached: false, stdio: "ignore" },
    );

    this.edgeProcess.on("error", (err) => {
      log.error("Edge process error", { message: err.message });
    });

    // Give Edge time to start and expose CDP endpoint
    log.info("Waiting for Edge to start (4s)…");
    await new Promise((r) => setTimeout(r, 4000));
    log.info("Edge started");
  }

  /**
   * Connect Playwright to the running Edge instance via CDP.
   * Mirrors Python's connect_to_edge().
   */
  async connectToEdge() {
    const { debuggingPort } = config.badr;
    const cdpUrl = `http://localhost:${debuggingPort}`;
    log.info(`Connecting Playwright via CDP → ${cdpUrl}`);

    this.browser = await chromium.connectOverCDP(cdpUrl);
    const contexts = this.browser.contexts();
    this.context = contexts.length
      ? contexts[0]
      : await this.browser.newContext();

    const pages = this.context.pages();
    this.page = pages.length ? pages[0] : await this.context.newPage();

    this.page.setDefaultTimeout(config.timeout);
    log.info("Playwright connected to Edge");
  }

  /**
   * Navigate to BADR and log in.
   * Mirrors Python's navigate_and_login() exactly:
   *  1. Navigate → wait for password field
   *  2. Fill & verify password (retry if mismatch)
   *  3. Click Connexion
   *  4. Wait 5s → handle active-session popup if present
   */
  async navigateAndLogin() {
    const { url, password } = config.badr;
    // NOTE: BADR authenticates via USB certificate – no username field exists.
    log.info(`Navigating to BADR: ${url}`);
    await this.page.goto(url, { waitUntil: "domcontentloaded" });

    // Wait for password field to be present (same as Python's wait.until)
    log.info("Waiting for password field…");
    await this.page.waitForSelector("#connexionForm\\:pwdConnexionId", {
      timeout: config.timeout,
    });

    // Fill password and verify value (mirrors Python's check + retry logic)
    log.info("Filling BADR password…");
    await this._fillAndVerify("#connexionForm\\:pwdConnexionId", password);

    await this.page.waitForTimeout(1000);

    // Click Connexion button
    log.info("Clicking Connexion…");
    await this.page.waitForSelector("#connexionForm\\:login", {
      state: "visible",
      timeout: config.timeout,
    });
    await this.page.click("#connexionForm\\:login");
    log.info("Connexion clicked – waiting for redirect…");

    // Wait 5s for page load (mirrors Python's time.sleep(5))
    await this.page.waitForTimeout(5000);

    // Handle active-session popup (appears AFTER clicking login, like Python does)
    try {
      const sessionLink = await this.page.$(
        "#connexionForm\\:sessionConnexionId",
      );
      if (sessionLink) {
        log.warn(
          "Active session detected – clicking to deactivate old session…",
        );
        await sessionLink.click();
        await this.page.waitForTimeout(5000);
        log.info("Old session deactivated – redirected to home");
      } else {
        log.info("No active session – direct login succeeded");
      }
    } catch (e) {
      log.warn("Session check error (non-critical)", { message: e.message });
    }

    log.info("BADR login successful");
  }

  /**
   * Fill an input and verify the value was accepted.
   * Clears and retries once if the value doesn't match (mirrors Python).
   */
  async _fillAndVerify(selector, value) {
    const field = this.page.locator(selector);

    const current = await field.inputValue();
    if (current === value) {
      log.info(`Field ${selector} already has correct value`);
      return;
    }
    if (current) {
      log.warn(`Field has stale value (len=${current.length}) – clearing…`);
      await field.clear();
      await this.page.waitForTimeout(500);
    }

    await field.fill(value);

    // Verify
    const filled = await field.inputValue();
    if (filled !== value) {
      log.warn(
        `Value mismatch (got len=${filled.length}, expected len=${value.length}) – retrying…`,
      );
      await field.clear();
      await this.page.waitForTimeout(500);
      await field.fill(value);
      log.info("Retry fill applied");
    }
  }

  /**
   * Full bootstrap: launch Edge → connect CDP → login.
   */
  async connect() {
    if (this.page && !this.page.isClosed()) {
      log.info("Reusing existing BADR page/session");
      return;
    }

    try {
      await this.connectToEdge();
      await this.navigateAndLogin();
      log.info("Connected to existing Edge CDP session");
      return;
    } catch (existingErr) {
      log.warn("No reusable Edge session found – launching fresh Edge", {
        message: existingErr.message,
      });
    }

    await this.startFreshEdge();
    await this.connectToEdge();
    await this.navigateAndLogin();
  }

  /**
   * Reconnect without relaunching Edge (CDP already running).
   */
  async reconnect() {
    if (this.page && !this.page.isClosed()) {
      log.info("BADR reconnect skipped: existing page is active");
      return;
    }

    await this.connectToEdge();
    await this.navigateAndLogin();
  }

  /**
   * Navigate to BADR Accueil and wait for page to stabilize.
   * Resets the DOM context to a known state before starting new operations.
   */
  async navigateToAccueil() {
    if (!this.page || this.page.isClosed()) {
      log.warn("BADR page is closed – cannot navigate to Accueil");
      return;
    }

    // First, close any open popups from previous operations
    const allPages = this.context.pages();
    for (const p of allPages) {
      if (p !== this.page && !p.isClosed()) {
        log.info("Closing stray popup before Accueil navigation");
        await p.close().catch(() => {});
      }
    }

    const { url } = config.badr;
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const contextRoot = pathParts.length ? `/${pathParts[0]}` : "";
    const accueilUrl = `${parsed.origin}${contextRoot}/views/hab/hab_index.xhtml`;

    // Check if we're already on Accueil AND the menu exists in the DOM
    const isOnAccueil = this.page.url().includes("/views/hab/hab_index.xhtml");
    const menuExists = await this.page
      .locator(".ui-panelmenu-header a:has-text('MISE EN DOUANE')")
      .isVisible()
      .catch(() => false);

    if (isOnAccueil && menuExists) {
      log.info("BADR already on Accueil — skipping navigation");
      return;
    }

    if (!isOnAccueil) {
      log.info("Not on Accueil – navigating now");
    } else {
      log.info("On Accueil URL but menu missing – re-navigating to stabilize");
    }

    log.info(`Navigating to BADR Accueil: ${accueilUrl}`);
    await this.page.goto(accueilUrl, { waitUntil: "networkidle" });
    await this.page.waitForTimeout(2000);
    log.info("BADR Accueil ready");
  }

  /**
   * Disconnect Playwright from Edge (does NOT kill the Edge process).
   */
  async disconnect() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      log.info("Playwright disconnected from Edge");
    }
  }

  /**
   * Kill the Edge process completely.
   */
  kill() {
    if (this.edgeProcess) {
      this.edgeProcess.kill();
      this.edgeProcess = null;
      log.info("Edge process killed");
    }
  }
}

module.exports = BADRConnection;
