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
    log.info("Launching Chromium for Portnet…");

    this.browser = await chromium.launch({
      // Use the installed Microsoft Edge (BADR runs in Chrome — see badrConnection.js).
      channel: "msedge",
      headless: config.headless,
      slowMo: config.slowMo,
      // Open the window maximized so the page can use the full screen.
      args: ["--start-maximized"],
    });

    // viewport: null → the page fills the actual (maximized) window instead of
    // Playwright's default 1280×720 emulated viewport, which otherwise leaves
    // empty white space at the right/bottom and clips Portnet's content.
    this.context = await this.browser.newContext({ viewport: null });

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

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(config.timeout);

    log.info("Navigating to Portnet…");
    await this.page.goto("https://cargo.portnet.ma/", {
      waitUntil: "domcontentloaded",
    });

    // Fill credentials
    const { username, password } = config.portnet;
    await this.page.locator("#auth-username").fill(username);
    await this.page.locator("#auth-password").fill(password);
    log.info("Credentials filled");

    // ── Manual CAPTCHA ───────────────────────────────────────────────────────
    console.log("\n========================================");
    console.log("  Solve the CAPTCHA and click 'Se connecter'.");
    console.log("  Automation will continue automatically.");
    console.log("========================================\n");

    // Wait up to 3 minutes for the authenticated URL (slow networks need more time).
    await this.page.waitForURL(
      (url) => url.toString().includes("cargo.portnet.ma/home"),
      { timeout: 180_000 },
    );

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
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      log.info("Portnet browser closed");
    }
  }
}

module.exports = PortnetLogin;
