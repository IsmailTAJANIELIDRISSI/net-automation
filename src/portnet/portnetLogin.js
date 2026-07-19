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
const config = require("../config/config");
const { createLogger } = require("../utils/logger");

const log = createLogger("PortnetLogin");

class PortnetLogin {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  /**
   * Launch Chromium and log into Portnet.
   * Pauses for manual CAPTCHA resolution then waits for the cargo home URL.
   *
   * @returns {import('playwright').Page} the authenticated Portnet page
   */
  async login() {
    log.info("Launching Edge (persistent profile) for Portnet…");

    // Persistent context (like BADR): reuses a real on-disk Edge profile so the
    // Portnet session cookie survives app restarts. viewport: null → the page
    // fills the actual (maximized) window instead of Playwright's 1280×720
    // emulated viewport, which otherwise clips Portnet's content.
    this.context = await chromium.launchPersistentContext(
      config.portnet.userDataDir,
      {
        // Use the installed Microsoft Edge (BADR runs in Chrome — see badrConnection.js).
        channel: "msedge",
        headless: config.headless,
        slowMo: config.slowMo,
        viewport: null,
        // Open the window maximized so the page can use the full screen.
        args: ["--start-maximized"],
      },
    );
    // browser() is null for a persistent context; keep the field for close().
    this.browser = this.context.browser();

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

    // A persistent context opens with one blank page — reuse it.
    this.page = this.context.pages()[0] || (await this.context.newPage());
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

      // Wait up to 3 minutes for the authenticated URL (slow networks need more time).
      await this.page.waitForURL(
        (url) => url.toString().includes("cargo.portnet.ma/home"),
        { timeout: 180_000 },
      );
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
    // Close the persistent context (flushes the profile — incl. the session
    // cookie — to disk so the next launch can reuse it and skip the CAPTCHA).
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.browser = null;
      log.info("Portnet browser closed");
    }
  }
}

module.exports = PortnetLogin;
