const { chromium } = require("playwright");

class LoginPortnetAutomation {
  constructor() {
    this.browser = null;
    this.page = null;
    this.step = 0;
  }

  log(action, target = null, value = null, status = "INFO") {
    this.step++;
    const ts = new Date().toISOString().replace("T", " ").split(".")[0];
    let msg = `[${ts}] [STEP ${String(this.step).padStart(2, "0")}] [${status}] ${action}`;
    if (target) msg += ` | target=${target}`;
    if (value) msg += ` | value=${value}`;
    if (this.page) msg += ` | url=${this.page.url()}`;
    console.log(msg);
  }

  async setup() {
    this.log("Initialize browser");
    this.browser = await chromium.launch({
      headless: false, // headed mode (visible browser)
    });

    const context = await this.browser.newContext();
    this.page = await context.newPage();

    this.log("Browser ready");
  }

  async teardown() {
    if (this.browser) {
      this.log("Close browser");
      await this.browser.close();
    }
  }

  async login() {
    this.log("Open page", "https://www.portnet.ma/");
    await this.page.goto("https://www.portnet.ma/", {
      waitUntil: "domcontentloaded",
    });

    // Try close popup if exists
    try {
      this.log("Try close popup", ".closeP");
      await this.page.locator(".closeP").click({ timeout: 5000 });
      this.log("Popup closed");
    } catch (e) {
      this.log("Popup not found, continue", ".closeP", null, "WARN");
    }

    // Wait for login fields
    this.log("Wait username field", "#j_username");
    const usernameField = this.page.locator("#j_username");
    await usernameField.waitFor();

    this.log("Wait password field", "#j_password");
    const passwordField = this.page.locator("#j_password");
    await passwordField.waitFor();

    const username = process.env.PORTNET_USERNAME || "GN41473";
    const password = process.env.PORTNET_PASSWORD || "830@6@M4yX4@";

    this.log("Fill username", "#j_username");
    await usernameField.fill(username);

    this.log("Fill password", "#j_password");
    await passwordField.fill(password);

    // ---- MANUAL CAPTCHA + SUBMIT ----
    this.log("Manual action required");
    console.log("\n========================================");
    console.log("Solve CAPTCHA and click LOGIN manually.");
    console.log("The script will detect authentication automatically.");
    console.log("========================================\n");

    // Wait for authenticated URL
    this.log("Waiting for authenticated URL", "cargo.portnet.ma/home");

    try {
      await this.page.waitForURL(
        (url) => url.toString().includes("cargo.portnet.ma/home"),
        { timeout: 120000 }, // 2 minutes max
      );

      this.log("Authentication detected", null, this.page.url(), "SUCCESS");
    } catch (err) {
      this.log(
        "Login timeout - authentication not detected",
        null,
        null,
        "ERROR",
      );
      throw new Error("Authentication not detected within timeout.");
    }
  }

  async run() {
    try {
      await this.setup();
      await this.login();
    } catch (err) {
      this.log(
        "Automation failed",
        null,
        `${err.name}: ${err.message}`,
        "ERROR",
      );
      console.error(err);
      throw err;
    } finally {
      await this.teardown();
    }
  }
}

(async () => {
  const app = new LoginPortnetAutomation();
  await app.run();
})();
