'use strict';
/**
 * PortnetLogin – reusable Playwright login module for Portnet.
 *
 * Key difference from standalone login-portnet.js:
 * - Does NOT close the browser after login
 * - Returns { browser, context, page } for subsequent automation steps
 * - Supports both manual CAPTCHA flow and headless (future)
 */

const { chromium }     = require('playwright');
const config           = require('../config/config');
const { createLogger } = require('../utils/logger');

const log = createLogger('PortnetLogin');

class PortnetLogin {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page    = null;
  }

  /**
   * Launch Chromium and log into Portnet.
   * Pauses for manual CAPTCHA resolution then waits for the cargo home URL.
   *
   * @returns {import('playwright').Page} the authenticated Portnet page
   */
  async login() {
    log.info('Launching Chromium for Portnet…');

    this.browser = await chromium.launch({
      headless: config.headless,
      slowMo:   config.slowMo,
    });

    this.context = await this.browser.newContext();
    this.page    = await this.context.newPage();
    this.page.setDefaultTimeout(config.timeout);

    log.info('Navigating to Portnet…');
    await this.page.goto('https://www.portnet.ma/', {
      waitUntil: 'domcontentloaded',
    });

    // Try closing the promotional popup
    try {
      await this.page.locator('.closeP').click({ timeout: 5000 });
      log.info('Popup closed');
    } catch (_) {
      log.info('No popup found – continuing');
    }

    // Fill credentials
    const { username, password } = config.portnet;
    await this.page.locator('#j_username').fill(username);
    await this.page.locator('#j_password').fill(password);
    log.info('Credentials filled');

    // ── Manual CAPTCHA ───────────────────────────────────────────────────────
    console.log('\n========================================');
    console.log('  Solve the CAPTCHA and click LOGIN.');
    console.log('  Automation will continue automatically.');
    console.log('========================================\n');

    // Wait up to 2 minutes for authenticated URL
    await this.page.waitForURL(
      (url) => url.toString().includes('cargo.portnet.ma/home'),
      { timeout: 120_000 }
    );

    log.info('Portnet authentication successful', { url: this.page.url() });
    return this.page;
  }

  /**
   * Close the browser session.
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      log.info('Portnet browser closed');
    }
  }
}

module.exports = PortnetLogin;
