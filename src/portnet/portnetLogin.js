"use strict";
/**
 * PortnetLogin – reusable Playwright login module for Portnet.
 *
 * Key difference from standalone login-portnet.js:
 * - Does NOT close the browser after login
 * - Returns { browser, context, page } for subsequent automation steps
 * - Supports both manual CAPTCHA flow and headless (future)
 */

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const config = require("../config/config");
const { createLogger } = require("../utils/logger");

const log = createLogger("PortnetLogin");

const CAPTCHA_TIMEOUT_MS = 15 * 60 * 1000;
const EDGE_START_TIMEOUT_MS = 30_000;

// Playwright's own launch adds --enable-automation, which announces the browser
// as automated and makes reCAPTCHA serve endless image rounds. So Edge is started
// as a normal browser (like badrConnection.js) and Playwright only attaches to it.
// These are the switches from Playwright's default set that the run depends on.
const EDGE_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--start-maximized",
  "--disable-popup-blocking",
  "--disable-prompt-on-repost",
  "--disable-hang-monitor",
  // Keep automating at full speed while the window is behind the app.
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

class PortnetLogin {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async _attach() {
    const { debuggingPort } = config.portnet;
    this.browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${debuggingPort}`,
      { slowMo: config.slowMo, timeout: 5000 },
    );
    this.context = this.browser.contexts()[0];
  }

  /** Reuse a Portnet Edge that is already open, otherwise start one. */
  async _openEdge() {
    if (this.browser?.isConnected()) return;

    try {
      await this._attach();
      log.info("Edge Portnet déjà ouvert — reconnexion.");
      return;
    } catch {
      // not running — start it below
    }

    const { browserPath, debuggingPort, userDataDir } = config.portnet;
    log.info(`Launching Edge for Portnet on port ${debuggingPort}…`);
    const args = [
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${userDataDir}`,
      ...EDGE_ARGS,
    ];
    if (config.headless) args.push("--headless=new");
    const edge = spawn(browserPath, args, { stdio: "ignore" });
    edge.on("error", (err) =>
      log.error("Edge process error", { message: err.message }),
    );

    const deadline = Date.now() + EDGE_START_TIMEOUT_MS;
    for (;;) {
      try {
        await this._attach();
        return;
      } catch (err) {
        if (Date.now() > deadline) {
          throw new Error(
            `Edge Portnet injoignable sur le port ${debuggingPort} (${err.message}). Fermez toutes les fenêtres Edge Portnet puis relancez.`,
          );
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  /**
   * Open Edge and log into Portnet.
   * Pauses for manual CAPTCHA resolution then waits for the cargo home URL.
   *
   * @returns {import('playwright').Page} the authenticated Portnet page
   */
  async login() {
    // The on-disk profile keeps Portnet's login token (localStorage) between
    // launches, so a still-valid session skips the login form and the CAPTCHA.
    await this._openEdge();

    // Apply a 90% zoom on every page Portnet loads (re-runs on each navigation,
    // top frame only to avoid double-zooming the cross-origin DS form iframe).
    await this.context.addInitScript(() => {
      if (window.top !== window.self) return;
      const applyZoom = () => {
        if (document.documentElement) {
          document.documentElement.style.zoom = "90%";
        }
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", applyZoom);
      } else {
        applyZoom();
      }
    });

    // Hide the floating "Contactez-nous" (Click2Connect) widget on every page
    // AND every frame. It sits bottom-right with a high z-index and can overlay
    // form/submit buttons, intercepting clicks and making the automation fail.
    // A CSS rule is robust: it works whether or not the widget is present, and
    // survives the widget re-rendering asynchronously. Class is matched by prefix
    // (`Click2Connect`) so a hashed CSS-module suffix can't break it.
    await this.context.addInitScript(() => {
      const injectHideStyle = () => {
        if (!document.head || document.getElementById("__hideClick2Connect")) {
          return;
        }
        const style = document.createElement("style");
        style.id = "__hideClick2Connect";
        style.textContent =
          '[class*="Click2Connect"]{display:none !important;}';
        document.head.appendChild(style);
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", injectHideStyle);
      } else {
        injectHideStyle();
      }
    });

    // Edge opens with one tab — reuse it, or the Portnet tab of a window left open.
    const pages = this.context.pages();
    this.page =
      pages.find((p) => p.url().includes("portnet.ma")) ||
      pages[0] ||
      (await this.context.newPage());
    this.page.setDefaultTimeout(config.timeout);

    log.info("Navigating to Portnet…");
    await this.page.goto("https://cargo.portnet.ma/", {
      waitUntil: "domcontentloaded",
    });

    // ── Already authenticated from the persisted profile? ─────────────────────
    // If the saved session cookie is still valid, Portnet redirects to /home and
    // no login (hence no CAPTCHA) is needed. Wait for whichever settles first —
    // the login field (→ log in) or the /home URL (→ already in) — so a slow
    // redirect isn't mistaken for the login page. Then decide from the URL.
    const loginField = this.page.locator("#auth-username");
    await Promise.race([
      loginField.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {}),
      this.page
        .waitForURL((url) => url.toString().includes("cargo.portnet.ma/home"), {
          timeout: 30_000,
        })
        .catch(() => {}),
    ]);
    const alreadyLoggedIn = this.page.url().includes("cargo.portnet.ma/home");

    if (alreadyLoggedIn) {
      log.info("Portnet: session réutilisée — déjà connecté, CAPTCHA ignoré.");
    } else {
      log.info("Portnet: session expirée ou absente — connexion manuelle requise.");

      // Fill credentials
      const { username, password } = config.portnet;
      await this.page.locator("#auth-username").fill(username);
      await this.page.locator("#auth-password").fill(password);
      log.info("Credentials filled");

      // Ensure "Se souvenir de moi" is ticked → longer server-side session, so the
      // persisted profile stays valid across launches (fewer CAPTCHAs). .check()
      // is a no-op if it's already checked; non-fatal if the control isn't found.
      try {
        await this.page
          .locator('.auth-remember-me input[type="checkbox"]')
          .check({ timeout: 5000 });
        log.info('"Se souvenir de moi" coché');
      } catch {
        log.warn('"Se souvenir de moi" introuvable — connexion sans.');
      }

      // ── Manual CAPTCHA ──────────────────────────────────────────────────────
      console.log("\n========================================");
      console.log("  Solve the CAPTCHA and click 'Se connecter'.");
      console.log("  Automation will continue automatically.");
      console.log("========================================\n");

      // A person is working here: a slow CAPTCHA must not fail the whole batch.
      // "commit" returns on the URL change; the networkidle wait below handles the
      // page load, which on a bad connection could otherwise use up this timeout.
      await this.page
        .waitForURL((url) => url.toString().includes("cargo.portnet.ma/home"), {
          timeout: CAPTCHA_TIMEOUT_MS,
          waitUntil: "commit",
        })
        .catch((err) => {
          if (err.name !== "TimeoutError") throw err;
          throw new Error(
            `Connexion Portnet non terminée après ${CAPTCHA_TIMEOUT_MS / 60_000} min (CAPTCHA non résolu).`,
          );
        });
    }

    // Extra safety: wait for the page to fully settle before handing it back.
    // On bad connections the DOM can still be loading after the URL change.
    await this.page
      .waitForLoadState("networkidle", { timeout: 60_000 })
      .catch(() =>
        log.warn("networkidle timed-out after login – proceeding anyway"),
      );

    log.info("Portnet authentication successful", { url: this.page.url() });
    return this.page;
  }

  /**
   * Close the browser session.
   */
  async close() {
    if (!this.browser) return;

    // browser.close() only disconnects from an attached Edge, and killing the
    // process can lose the saved login. Browser.close is a normal Edge shutdown.
    try {
      const session = await this.browser.newBrowserCDPSession();
      await session.send("Browser.close");
    } catch {
      // the connection drops as Edge exits
    }
    await this.browser.close().catch(() => {});
    this.browser = null;
    this.context = null;
    log.info("Portnet browser closed");
  }
}

module.exports = PortnetLogin;
