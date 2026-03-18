"use strict";
require("dotenv").config();

const config = {
  // ── BADR ──────────────────────────────────────────────────────────────────
  badr: {
    url: process.env.BADR_URL || "https://badr.douane.gov.ma:40444/badr/Login",
    username: process.env.BADR_USERNAME || "",
    password: process.env.BADR_PASSWORD || "",
    edgePath:
      process.env.EDGE_PATH ||
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    debuggingPort: parseInt(process.env.BADR_CDP_PORT || "9222", 10),
    userDataDir: process.env.BADR_PROFILE_DIR || "C:\\Temp\\badr-edge-profile",
    // Fixed values for lot lookup
    bureauCode: process.env.BADR_BUREAU_CODE || "301",
    bureauLabel:
      process.env.BADR_BUREAU_LABEL || "CASA/NOUASSER-FRET(301)(301)",
    operateurCode: process.env.BADR_OPERATEUR_CODE || "1063",
    operateurLabel:
      process.env.BADR_OPERATEUR_LABEL ||
      "CIE NATIONALE ROYAL AIR MAROC(81/9667)",
  },

  // ── PORTNET ───────────────────────────────────────────────────────────────
  portnet: {
    baseUrl: "https://www.portnet.ma/",
    cargoUrl: "https://cargo.portnet.ma",
    username: process.env.PORTNET_USERNAME || "",
    password: process.env.PORTNET_PASSWORD || "",
    // Fixed form values
    agrement: {
      searchDescription: "MED AFRICA LOGISTICS",
    },
    form: {
      anticipation: "0", // Non
      typeDSReference: "01", // Maritime / Aérien
      typeDsRef: "Aerien", // inner DS search dialog
      arrondissement: "373", // TELECONTROLE IMPORT FRET
      lieuStockage: "MAG.RAM IMP. NOUASSER", // text match
    },
  },

  // ── EMAIL NOTIFICATION ────────────────────────────────────────────────────
  email: {
    enabled: process.env.EMAIL_ENABLED === "true",
    host: process.env.EMAIL_HOST || "smtp.gmail.com",
    port: parseInt(process.env.EMAIL_PORT || "587", 10),
    user: process.env.EMAIL_USER || "",
    pass: process.env.EMAIL_PASS || "",
    to: process.env.EMAIL_TO || "",
    from: process.env.EMAIL_FROM || "",
  },

  // ── GENERAL ───────────────────────────────────────────────────────────────
  headless: process.env.HEADLESS === "true",
  slowMo: parseInt(process.env.SLOW_MO || "50", 10),
  timeout: parseInt(process.env.TIMEOUT || "120000", 10),
  logsDir: process.env.LOGS_DIR || "logs",
};

module.exports = config;
