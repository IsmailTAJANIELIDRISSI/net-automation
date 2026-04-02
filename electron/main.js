"use strict";
/**
 * Electron Main Process
 * - Creates the BrowserWindow
 * - Handles all IPC between the React UI and the Node.js automation layer
 * - Streams automation logs to the renderer in real-time
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

// ── Dev / Prod detection ─────────────────────────────────────────────────────
const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

let mainWindow = null;

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: "#020617", // slate-950
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0f172a",
      symbolColor: "#94a3b8",
      height: 32,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    show: false,
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ── Forward automation logs to renderer ───────────────────────────────────────
function setupLogForwarding() {
  try {
    const { logEmitter } = require("../src/utils/logger");
    logEmitter.on("log", (entry) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("log", entry);
      }
    });
  } catch (e) {
    console.error("Could not attach log emitter:", e.message);
  }
}
setupLogForwarding();

// ── Helper: send log directly (for Electron-level messages) ──────────────────
function sendLog(level, context, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("log", {
      level,
      context,
      message,
      ts: new Date().toISOString(),
    });
  }
  console.log(`[${level.toUpperCase()}] [${context}] ${message}`);
}

function sendProgress(acheminementId, status, extra = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("progress", {
      acheminementId,
      status,
      ...extra,
    });
  }
}

let sharedPortnetApp = null;
let sharedPortnetPage = null;
let sharedBadrConn = null;

async function ensurePortnetSession() {
  const PortnetLogin = require("../src/portnet/portnetLogin");

  if (sharedPortnetPage && !sharedPortnetPage.isClosed()) {
    return sharedPortnetPage;
  }

  if (!sharedPortnetApp) {
    sharedPortnetApp = new PortnetLogin();
    sendLog("info", "Portnet", "Launching shared Portnet session…");
    sendLog(
      "info",
      "Portnet",
      ">>> Résolvez le CAPTCHA dans la fenêtre du navigateur <<<",
    );
  }

  sharedPortnetPage = await sharedPortnetApp.login();
  sendLog("info", "Portnet", "Shared Portnet session ready.");
  return sharedPortnetPage;
}

async function ensureBadrSession() {
  const BADRConnection = require("../src/badr/badrConnection");

  if (sharedBadrConn?.page && !sharedBadrConn.page.isClosed()) {
    return sharedBadrConn;
  }

  if (!sharedBadrConn) {
    sharedBadrConn = new BADRConnection();
  }

  try {
    await sharedBadrConn.connect();
  } catch (err) {
    sendLog(
      "warn",
      "BADR",
      `Shared BADR connect failed (${err.message}) — retrying with reconnect...`,
    );
    await sharedBadrConn.reconnect();
  }

  sendLog("info", "BADR", "Shared BADR session ready.");
  return sharedBadrConn;
}

async function closeSharedSessions() {
  if (sharedPortnetApp) {
    await sharedPortnetApp.close().catch(() => {});
    sharedPortnetApp = null;
    sharedPortnetPage = null;
  }
  if (sharedBadrConn) {
    await sharedBadrConn.disconnect().catch(() => {});
    sharedBadrConn.kill();
    sharedBadrConn = null;
  }
}

const CHECKPOINT_KEY = "automationState";

function readAcheminementFile(folderPath) {
  const savePath = path.join(folderPath, "acheminement.json");
  if (!fs.existsSync(savePath)) return {};

  try {
    return JSON.parse(fs.readFileSync(savePath, "utf8"));
  } catch {
    return {};
  }
}

/** JSON may contain "" for empty fields — treat as missing so manifest PDF can fill. */
function pickSavedOrExtracted(savedVal, extractedVal, fallback = "") {
  if (savedVal != null && String(savedVal).trim() !== "") {
    return savedVal;
  }
  if (extractedVal != null && String(extractedVal).trim() !== "") {
    return extractedVal;
  }
  return fallback;
}

function writeAcheminementFile(folderPath, data) {
  const savePath = path.join(folderPath, "acheminement.json");
  fs.writeFileSync(savePath, JSON.stringify(data, null, 2), "utf8");
}

function normalizeLotReference(value) {
  if (!value) return "";
  const text = String(value).trim();
  const match = text.match(/^(\d+)-(\d+)$/);
  if (!match) return text;

  const left = String(parseInt(match[1], 10));
  const right = match[2];
  return `${Number.isNaN(Number(left)) ? match[1] : left}-${right}`;
}

const {
  extractLotReferenceFromFilename,
  extractManifestMetricsFromPdfFile,
  pickManifestPdf,
  pickMawbPdf,
} = require("../src/utils/manifestPdfExtract");

function extractLotReferenceFromFolder(folderPath) {
  try {
    const fileNames = fs
      .readdirSync(folderPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);

    const mawbFile = fileNames.find((name) => /\bmawb\b/i.test(name));
    const manifesteFile = fileNames.find((name) => /\bmanifeste\b/i.test(name));

    const mawbRef = mawbFile ? extractLotReferenceFromFilename(mawbFile) : "";
    if (mawbRef) return mawbRef;

    const manifesteRef = manifesteFile
      ? extractLotReferenceFromFilename(manifesteFile)
      : "";
    if (manifesteRef) return manifesteRef;

    for (const name of fileNames) {
      const ref = extractLotReferenceFromFilename(name);
      if (ref) return ref;
    }
  } catch {
    return "";
  }

  return "";
}

function getAutomationState(folderPath) {
  return readAcheminementFile(folderPath)[CHECKPOINT_KEY] || null;
}

function updateAutomationState(folderPath, patch) {
  const current = readAcheminementFile(folderPath);
  current[CHECKPOINT_KEY] = {
    ...(current[CHECKPOINT_KEY] || {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeAcheminementFile(folderPath, current);
  return current[CHECKPOINT_KEY];
}

function mapCheckpointToStatus(state) {
  switch (state?.phase) {
    case "portnet_sent_waiting":
      return "submitting-portnet";
    case "portnet_submitted":
      return "portnet-submitted";
    case "portnet_accepted":
      return "portnet-accepted";
    case "badr_done":
      return "done";
    case "weight_mismatch":
      return "weight-mismatch";
    case "partiel_skip":
      return "partiel-skip";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function getPollIntervalMs(attempts) {
  if (attempts < 5) return 60_000;
  if (attempts < 20) return 120_000;
  return 180_000;
}

function normalizePortnetStatus(statusText) {
  return String(statusText || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isEnvoyeeStatus(statusText) {
  return normalizePortnetStatus(statusText).startsWith("envoye");
}

function isAcceptedStatus(statusText) {
  return normalizePortnetStatus(statusText).startsWith("acceptee");
}

function isRejectedStatus(statusText) {
  return normalizePortnetStatus(statusText).startsWith("rejetee");
}

async function prepareLotAndWeightCheck(acheminement) {
  const {
    id,
    folderPath,
    refNumber: refFromInput,
    poidTotal: poidFromInput,
    sequenceNumber,
    lieuChargement,
    partiel,
  } = acheminement;

  if (partiel) {
    updateAutomationState(folderPath, {
      phase: "partiel_skip",
      reason: "partiel",
    });
    sendLog("warn", "Automation", `"${id}" marqué LTA Partielle – ignoré`);
    sendProgress(id, "partiel-skip");
    return { success: false, skipped: true, reason: "partiel" };
  }

  const folderLotReference = extractLotReferenceFromFolder(folderPath);

  let manifestPdfMetrics = null;
  const manifestPath = acheminement.manifeste
    ? path.join(folderPath, acheminement.manifeste)
    : null;
  if (manifestPath && fs.existsSync(manifestPath)) {
    try {
      manifestPdfMetrics =
        await extractManifestMetricsFromPdfFile(manifestPath);
      if (manifestPdfMetrics?.ok) {
        sendLog(
          "info",
          "BADR",
          "Manifeste PDF: en-tête lu (réf. / Pcs / kg / devise si présents).",
        );
      }
    } catch (e) {
      console.error("[manifest pdf]", e.message);
    }
  }

  const resolvedRef =
    normalizeLotReference(refFromInput) ||
    normalizeLotReference(folderLotReference) ||
    normalizeLotReference(manifestPdfMetrics?.refNumber) ||
    "";

  if (!resolvedRef) {
    sendLog(
      "error",
      "BADR",
      "Référence LTA introuvable — vérifiez les noms de fichiers (ex. MAWB 157-54440131 (002).pdf) ou le texte du manifeste.",
    );
    sendProgress(id, "error", { error: "Référence LTA introuvable" });
    return { success: false, error: "Référence LTA introuvable" };
  }

  const nombreMerged =
    String(acheminement.nombreContenant || "").trim() ||
    String(manifestPdfMetrics?.nombreContenant || "").trim();
  const poidMerged =
    String(poidFromInput || "").trim() ||
    String(manifestPdfMetrics?.poidTotal || "").trim();
  const currencyMerged =
    String(acheminement.currency || "").trim() ||
    String(manifestPdfMetrics?.currency || "").trim() ||
    "MAD";
  const totalMerged =
    String(acheminement.totalValue || "").trim() ||
    String(manifestPdfMetrics?.totalValue || "").trim();

  const BADRLotLookup = require("../src/badr/badrLotLookup");
  const BADRPreapurement = require("../src/badr/badrPreapurement");

  let lotInfo = null;

  try {
    const badrConn = await ensureBadrSession();
    await badrConn.navigateToAccueil();

    if (!sequenceNumber || sequenceNumber.trim() === "") {
      sendLog("info", "BADR", "No sequence number – looking up in BADR…");
      const lotLookup = new BADRLotLookup(badrConn.page);
      await lotLookup.openLotPopup();
      lotInfo = await lotLookup.searchLot(resolvedRef);
      await lotLookup.close();

      if (lotInfo.isEmpty) {
        updateAutomationState(folderPath, {
          phase: "error",
          error: "Pas encours manifest",
        });
        sendLog(
          "warn",
          "BADR",
          `Pas encours manifest pour ${resolvedRef} – email envoyé`,
        );
        sendProgress(id, "error", { error: "Pas encours manifest" });
        return { success: false, error: "Pas encours manifest" };
      }

      if (lotInfo.isPartiel) {
        updateAutomationState(folderPath, {
          phase: "partiel_skip",
          reason: "partiel",
          rowCount: lotInfo.rowCount,
        });
        sendLog(
          "warn",
          "BADR",
          `DS Partiel détecté pour ${resolvedRef} (${lotInfo.rowCount} lignes) – ignoré`,
        );
        sendProgress(id, "partiel-skip");
        return { success: false, skipped: true, reason: "partiel" };
      }

      sendLog(
        "info",
        "BADR",
        `Lot trouvé: ${lotInfo.declarationRef} | Lieu: ${lotInfo.lieuChargement}`,
      );

      lotInfo.lotReference =
        normalizeLotReference(folderLotReference) ||
        normalizeLotReference(lotInfo.lotReference) ||
        normalizeLotReference(resolvedRef) ||
        "";

      const seqDisplay =
        String(parseInt(lotInfo.sequenceNum, 10)) +
        (lotInfo.cle ? ` ${lotInfo.cle}` : "");
      lotInfo.sequenceNum = seqDisplay;

      try {
        const existing = readAcheminementFile(folderPath);
        existing.sequenceNumber = seqDisplay;
        existing.lieuChargement = lotInfo.lieuChargement || "";
        existing.lotReference =
          lotInfo.lotReference || existing.lotReference || "";
        writeAcheminementFile(folderPath, existing);
      } catch (e) {
        console.error("[sequenceNumber save] Failed:", e.message);
      }

      sendProgress(id, "running", {
        sequenceNumber: seqDisplay,
        lieuChargement: lotInfo.lieuChargement || "",
      });
    } else {
      const parts = sequenceNumber.trim().split(/[\s-]+/);
      const serie = parts[0].padStart(7, "0");
      const cle = parts[1] || "";
      sendLog("info", "BADR", `Using provided sequence: ${serie} ${cle}`);

      const existingData = readAcheminementFile(folderPath);
      const persistedLotReference =
        normalizeLotReference(folderLotReference) ||
        normalizeLotReference(
          existingData?.automationState?.lotInfo?.lotReference,
        ) ||
        normalizeLotReference(existingData?.automationState?.lotReference) ||
        normalizeLotReference(existingData?.lotReference) ||
        normalizeLotReference(resolvedRef) ||
        "";

      lotInfo = {
        declarationRef: resolvedRef
          ? `301-000-${new Date().getFullYear()}-${serie}-${cle}`
          : "",
        bureau: "301",
        regime: "000",
        annee: String(new Date().getFullYear()),
        serie,
        cle,
        sequenceNum: `${String(parseInt(serie, 10))}${cle ? ` ${cle}` : ""}`,
        lieuChargement: lieuChargement || "",
        lotReference: persistedLotReference,
      };
    }

    sendLog(
      "info",
      "BADR",
      "Restarting with MISE EN DOUANE for preapurement check…",
    );
    const preap = new BADRPreapurement(badrConn.page);
    const poidsInfo = await preap.getPoidsBrut(lotInfo, resolvedRef);

    const poidsBadr = parseFloat(String(poidsInfo.poidsBrut).replace(",", "."));
    const poidsUser = parseFloat(String(poidMerged).replace(",", "."));

    if (!isNaN(poidsBadr) && !isNaN(poidsUser)) {
      const diff = Math.abs(poidsBadr - poidsUser);

      if (diff > 20) {
        updateAutomationState(folderPath, {
          phase: "partiel_skip",
          error: "Partiel skip – weight diff > 20 kg",
          badrWeight: poidsBadr,
          userWeight: poidsUser,
          diff,
        });
        sendLog(
          "warn",
          "WeightCheck",
          `Écart de poids > 20 kg (${diff.toFixed(2)} kg) — traitement arrêté (LTA partielle)`,
        );
        sendLog(
          "warn",
          "ALERT_MAIL",
          `[TODO MAIL] Écart poids critique pour ${resolvedRef}: ${diff.toFixed(2)} kg (BADR=${poidsBadr}, SAISIE=${poidsUser})`,
        );
        sendProgress(id, "partiel-skip", {
          badrWeight: poidsBadr,
          userWeight: poidsUser,
          diff,
        });
        return {
          success: false,
          error: "Partiel skip – weight diff > 20 kg",
          poidsBadr,
          poidsUser,
        };
      }

      if (diff > 5) {
        updateAutomationState(folderPath, {
          phase: "weight_mismatch",
          error: "Weight mismatch > 5kg – verify with Abdelhak",
          badrWeight: poidsBadr,
          userWeight: poidsUser,
          diff,
        });
        sendLog(
          "warn",
          "WeightCheck",
          `Écart de poids ${diff.toFixed(2)} kg (> 5 kg) (BADR: ${poidsBadr} kg / saisie: ${poidsUser} kg) — arrêt et vérification requise`,
        );
        sendLog(
          "warn",
          "ALERT_MAIL",
          `[TODO MAIL] Écart poids > 5kg pour ${resolvedRef}: ${diff.toFixed(2)} kg (BADR=${poidsBadr}, SAISIE=${poidsUser})`,
        );
        sendProgress(id, "weight-mismatch", {
          badrWeight: poidsBadr,
          userWeight: poidsUser,
          diff,
        });
        return {
          success: false,
          error: "Weight mismatch > 5kg – verify with Abdelhak",
          poidsBadr,
          poidsUser,
        };
      }

      if (diff > 0) {
        sendLog(
          "info",
          "WeightCheck",
          `Écart de poids ${diff.toFixed(2)} kg (<= 5 kg) — continuation vers Portnet`,
        );
      }
    }

    sendLog("info", "WeightCheck", `Poids OK: ${poidsBadr} kg`);

    // Always use BADR weight as the authoritative value for Portnet submission.
    // If the user entered a different value it is ignored — only the BADR-confirmed
    // weight is forwarded downstream.
    lotInfo.poidsBrut = poidsBadr;

    // Persist the corrected weight back to acheminement.json so the UI reflects it.
    try {
      const existingData = readAcheminementFile(folderPath);
      existingData.poidTotal = String(poidsBadr);
      writeAcheminementFile(folderPath, existingData);
    } catch (e) {
      console.error("[poidsBrut persist] Failed:", e.message);
    }

    if (!isNaN(poidsBadr)) {
      sendProgress(id, "running", { badrWeight: poidsBadr });
    }

    updateAutomationState(folderPath, {
      phase: "badr_checked",
      lotInfo,
      badrWeight: poidsBadr,
      userWeight: poidMerged,
    });

    return {
      success: true,
      lotInfo,
      formFields: {
        refNumber: resolvedRef,
        nombreContenant: nombreMerged,
        currency: currencyMerged,
        totalValue: totalMerged,
      },
    };
  } catch (err) {
    sendLog(
      "error",
      "BADR",
      `prepareLotAndWeightCheck failed for "${id}": ${err.message}`,
    );
    throw err;
  }
}

async function submitPortnetPhase(acheminement, lotInfo, portnetPage) {
  const {
    id,
    folderPath,
    refNumber,
    scelle1,
    scelle2,
    nombreContenant,
    poidTotal,
    lieuChargement,
    currency,
    totalValue,
  } = acheminement;

  const PortnetDsCombine = require("../src/portnet/portnetDsCombine");

  sendLog("info", "Portnet", `Preparing Portnet submission for "${id}"…`);
  sendProgress(id, "filling-form");

  const dsCombine = new PortnetDsCombine(portnetPage);
  const fillResult = await dsCombine.fillEntete({
    sequenceNum: lotInfo.sequenceNum,
    refNumber: refNumber || undefined,
    lieuChargement: lieuChargement || undefined,
    montant: totalValue || undefined,
    deviseId: currency || undefined,
    folderPath: folderPath || undefined,
    scelle1: scelle1 || undefined,
    scelle2: scelle2 || undefined,
    nombreContenant: nombreContenant || undefined,
    // Prefer BADR-confirmed weight; fall back to user-entered poidTotal only if
    // no BADR weight was resolved (e.g. checkpoint resume path).
    poidsBrut:
      (lotInfo.poidsBrut != null ? String(lotInfo.poidsBrut) : null) ||
      poidTotal ||
      undefined,
  });

  if (fillResult?.stoppedAfterAnnexCompression) {
    updateAutomationState(folderPath, {
      phase: "annexe_compression_debug_stop",
      error: null,
      compressedOutputDir: fillResult.compressedOutputDir || null,
      updatedAt: new Date().toISOString(),
    });
    sendLog(
      "warn",
      "Portnet",
      `Debug stop after annexe compression for "${id}". Files available in "${fillResult.compressedOutputDir || folderPath}". Submission intentionally skipped.`,
    );
    sendProgress(id, "running", {
      debugStop: true,
      compressedOutputDir: fillResult.compressedOutputDir || folderPath,
    });
    return {
      success: true,
      skipped: true,
      debugStop: true,
      compressedOutputDir: fillResult.compressedOutputDir || folderPath,
    };
  }

  sendLog("info", "Portnet", `Submitting request for "${id}"…`);
  sendProgress(id, "submitting-portnet");

  const portnetRef = await dsCombine.submitRequest(lotInfo.sequenceNum);
  updateAutomationState(folderPath, {
    // Mark as "sent click done" first; real submitted means consultation row = Envoyee.
    phase: "portnet_sent_waiting",
    portnetRef,
    submittedAt: new Date().toISOString(),
    attempts: 0,
    lotInfo,
    error: null,
  });
  sendProgress(id, "monitoring-portnet", { portnetRef, attempts: 0 });
  sendLog(
    "info",
    "Portnet",
    `Submit clicked for "${id}" (${portnetRef}). Waiting consultation status = Envoyee before marking as submitted.`,
  );

  return { success: true, portnetRef };
}

async function finalizeAcceptedOnBadr(acheminement, badrRef) {
  const { id, folderPath, scelle1, scelle2 } = acheminement;
  const BADRDsCombineFinalize = require("../src/badr/badrDsCombineFinalize");

  try {
    const badrConn = await ensureBadrSession();
    await badrConn.navigateToAccueil();

    sendLog("info", "BADR", `Proceeding to finalize on BADR for "${id}"...`);
    sendProgress(id, "badr-downloading", { declarationRef: badrRef });

    // Extract LTA rank from folder name (e.g., "1er LTA" → "1er")
    const folderName = path.basename(folderPath);
    const ltaRankMatch = folderName.match(/^(\d+(?:er|eme|éme|ème))/i);
    const ltaRank = ltaRankMatch ? ltaRankMatch[1] : "";

    // Get lot reference from acheminement file if available
    const achData = readAcheminementFile(folderPath);
    const lotReference =
      normalizeLotReference(extractLotReferenceFromFolder(folderPath)) ||
      normalizeLotReference(achData?.automationState?.lotInfo?.lotReference) ||
      normalizeLotReference(achData?.automationState?.lotReference) ||
      normalizeLotReference(achData?.lotReference) ||
      normalizeLotReference(acheminement?.lotReference) ||
      "";

    const finalizer = new BADRDsCombineFinalize(badrConn.page);
    const parsedSerie = badrRef.slice(0, -1);
    const parsedCle = badrRef.slice(-1);

    await finalizer.processFinalization(
      "301",
      "000",
      parsedSerie,
      parsedCle,
      scelle1,
      scelle2,
      ltaRank,
      lotReference,
    );

    updateAutomationState(folderPath, {
      phase: "badr_done",
      badrRef,
      completedAt: new Date().toISOString(),
      error: null,
    });
    sendProgress(id, "done", { declarationRef: badrRef });
    sendLog("info", "Process", `Workflow fully complete for "${id}"!`);
    return { success: true, declarationRef: badrRef };
  } catch (err) {
    updateAutomationState(folderPath, {
      phase: "portnet_accepted",
      badrRef,
      badrFinalizeError: err.message,
      error: err.message,
    });
    sendProgress(id, "error", { error: err.message });
    sendLog("error", "Automation", `Failed for "${id}": ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function monitorPendingPortnetRequests(acheminements, portnetPage) {
  const PortnetDsCombine = require("../src/portnet/portnetDsCombine");
  const dsCombine = new PortnetDsCombine(portnetPage);

  const pending = new Map();
  const claimedAcceptedRefs = new Set();

  for (const ach of acheminements) {
    const state = getAutomationState(ach.folderPath);
    if (state?.badrRef) {
      claimedAcceptedRefs.add(String(state.badrRef));
    }
  }

  for (const ach of acheminements) {
    const state = getAutomationState(ach.folderPath);
    if (!state) continue;

    if (state.badrRef) {
      await finalizeAcceptedOnBadr(ach, state.badrRef);
      continue;
    }

    if (state.portnetRef && !state.badrRef) {
      pending.set(ach.id, ach);
    }
  }

  if (pending.size === 0) return;

  await dsCombine.openConsultationPage();

  // ── BADR session refresh every 2 minutes (prevent logout during long polling) ──
  let badrBusy = false;
  let badrRefreshInProgress = false;
  let badrRefreshInterval = setInterval(async () => {
    if (badrBusy || badrRefreshInProgress) return;
    badrRefreshInProgress = true;
    try {
      sendLog(
        "info",
        "BADR",
        "Refreshing BADR session to prevent timeout during Portnet polling...",
      );
      const badrConn = await ensureBadrSession();
      await badrConn.navigateToAccueil();
      sendLog("info", "BADR", "BADR session refreshed successfully.");
    } catch (err) {
      sendLog("warn", "BADR", `Failed to refresh BADR session: ${err.message}`);
    } finally {
      badrRefreshInProgress = false;
    }
  }, 120000); // 120 seconds = 2 minutes

  const maxAttempts = 240;
  try {
    while (pending.size > 0) {
      let highestAttempts = 0;

      for (const ach of pending.values()) {
        const state = getAutomationState(ach.folderPath);
        if (!state?.portnetRef) {
          pending.delete(ach.id);
          continue;
        }

        const attempts = (state.attempts || 0) + 1;
        highestAttempts = Math.max(highestAttempts, attempts);
        sendProgress(ach.id, "monitoring-portnet", {
          portnetRef: state.portnetRef,
          attempts,
        });

        sendLog(
          "info",
          "Portnet",
          `Consultation check ${attempts}/${maxAttempts} for "${ach.id}" (${state.portnetRef})...`,
        );

        const {
          found,
          statusText,
          refDsRaw,
          createdAtRaw,
          numeroManifesteRaw,
        } = await dsCombine.getConsultationStatus(state.portnetRef, {
          submittedAt: state.submittedAt || null,
          excludeRefDs: Array.from(claimedAcceptedRefs),
          anchorCreatedAtRaw: state.consultationCreatedAtRaw || null,
          anchorNumeroManifesteRaw: state.consultationNumeroManifeste || null,
          preferNewest:
            !state.consultationCreatedAtRaw &&
            state.phase === "portnet_sent_waiting",
        });

        updateAutomationState(ach.folderPath, {
          attempts,
          lastCheckedAt: new Date().toISOString(),
          lastSeenStatus: found ? statusText : "NOT_FOUND",
        });

        if (!found) {
          sendLog(
            "info",
            "Portnet",
            `Row for ${state.portnetRef} not found in consultation yet.`,
          );
          continue;
        }

        if (!state.consultationCreatedAtRaw && createdAtRaw) {
          updateAutomationState(ach.folderPath, {
            consultationCreatedAtRaw: createdAtRaw,
            consultationNumeroManifeste: numeroManifesteRaw || "",
          });
          sendLog(
            "info",
            "Portnet",
            `Anchored consultation row for "${ach.id}" at createdAt=${createdAtRaw}, manifeste=${numeroManifesteRaw || "N/A"} (will use manifeste to disambiguate if multiple rows share timestamp).`,
          );
        }

        sendLog(
          "info",
          "Portnet",
          `Current status for ${state.portnetRef}: ${statusText}`,
        );

        if (
          isEnvoyeeStatus(statusText) &&
          state.phase !== "portnet_submitted"
        ) {
          updateAutomationState(ach.folderPath, {
            phase: "portnet_submitted",
            submittedConfirmedAt: new Date().toISOString(),
            error: null,
          });
          sendProgress(ach.id, "portnet-submitted", {
            portnetRef: state.portnetRef,
          });
          sendLog(
            "info",
            "Portnet",
            `Submission confirmed on consultation (Envoyee) for "${ach.id}" (${state.portnetRef}).`,
          );
        }

        if (isAcceptedStatus(statusText)) {
          const fullRefDs = String(refDsRaw || "").trim();
          const shortRef = fullRefDs.substring(10).replace(/^0+/, "");

          if (!shortRef || !fullRefDs) {
            sendLog(
              "warn",
              "Portnet",
              `Acceptée found for ${state.portnetRef} but refDsMead extraction failed (raw="${fullRefDs}", createdAt=${createdAtRaw || "n/a"}, manifeste=${numeroManifesteRaw || "n/a"}). Waiting next poll...`,
            );
            continue;
          }

          if (claimedAcceptedRefs.has(shortRef)) {
            sendLog(
              "info",
              "Portnet",
              `Acceptée found for ${state.portnetRef} with refDsMead=${shortRef}, but already claimed by another LTA. Skipping...`,
            );
            continue;
          }

          claimedAcceptedRefs.add(shortRef);

          updateAutomationState(ach.folderPath, {
            phase: "portnet_accepted",
            badrRef: shortRef,
            acceptedAt: new Date().toISOString(),
            error: null,
          });
          sendProgress(ach.id, "portnet-accepted", {
            declarationRef: shortRef,
          });
          pending.delete(ach.id);
          badrBusy = true;
          try {
            await finalizeAcceptedOnBadr(ach, shortRef);
          } finally {
            badrBusy = false;
          }
        } else if (isRejectedStatus(statusText)) {
          const error = `DS Combinée request was REJECTED for ${state.portnetRef}! Please check manually.`;
          updateAutomationState(ach.folderPath, {
            phase: "error",
            error,
            rejectedAt: new Date().toISOString(),
          });
          sendProgress(ach.id, "error", { error });
          sendLog("error", "Automation", `Failed for "${ach.id}": ${error}`);
          pending.delete(ach.id);
        }
      }

      if (pending.size === 0) break;
      if (highestAttempts >= maxAttempts) {
        for (const ach of pending.values()) {
          const state = getAutomationState(ach.folderPath);
          const error = `Timed out waiting for Acceptée status for ${state?.portnetRef || ach.refNumber}`;
          updateAutomationState(ach.folderPath, { phase: "error", error });
          sendProgress(ach.id, "error", { error });
          sendLog("error", "Automation", `Failed for "${ach.id}": ${error}`);
        }
        break;
      }

      const waitMs = getPollIntervalMs(highestAttempts);
      sendLog(
        "info",
        "Portnet",
        `Pending requests remain (${pending.size}). Waiting ${Math.round(waitMs / 60000)} minute(s) before refreshing consultation...`,
      );
      await portnetPage.waitForTimeout(waitMs);
      await portnetPage.reload({ waitUntil: "networkidle" });

      // Re-apply sort after reload (sort is lost when page reloads)
      await dsCombine._ensureConsultationSortedByCreatedAtDesc();
    }
  } finally {
    clearInterval(badrRefreshInterval);
    sendLog("info", "BADR", "BADR session refresh timer stopped.");
  }
}

async function runAutomationTask(
  acheminement,
  { stopAfterSubmit = false, sharedPortnetPage = null } = {},
) {
  const { id, folderPath } = acheminement;

  sendLog("info", "Automation", `Starting automation for: ${id}`);
  sendProgress(id, "running");

  const checkpoint = getAutomationState(folderPath);
  const hasSubmittedPortnet = !!checkpoint?.portnetRef;
  const hasAcceptedPortnet = !!checkpoint?.badrRef;

  if (checkpoint?.phase === "badr_done") {
    sendLog("info", "Automation", `Skipping "${id}" — already completed.`);
    sendProgress(id, "done", { declarationRef: checkpoint.badrRef });
    return { success: true, declarationRef: checkpoint.badrRef, skipped: true };
  }

  if (hasAcceptedPortnet) {
    sendLog(
      "info",
      "Automation",
      `Resuming "${id}" from accepted checkpoint (${checkpoint.badrRef}).`,
    );
    return await finalizeAcceptedOnBadr(acheminement, checkpoint.badrRef);
  }

  let portnetPage = sharedPortnetPage;

  try {
    if (!hasSubmittedPortnet) {
      const prep = await prepareLotAndWeightCheck(acheminement);
      if (!prep.success) return prep;

      if (!portnetPage) {
        sendProgress(id, "captcha-waiting");
        portnetPage = await ensurePortnetSession();
      }

      const submitResult = await submitPortnetPhase(
        { ...acheminement, ...(prep.formFields || {}) },
        prep.lotInfo,
        portnetPage,
      );
      if (submitResult?.debugStop) {
        return submitResult;
      }
      if (!submitResult.success || stopAfterSubmit) {
        return submitResult;
      }
    } else {
      const resumeStatus =
        checkpoint.phase === "portnet_submitted"
          ? "portnet-submitted"
          : "monitoring-portnet";
      sendLog(
        "info",
        "Automation",
        `Checkpoint found for "${id}" — request already submitted (${checkpoint.portnetRef}), skipping precheck + re-send.`,
      );
      sendProgress(id, resumeStatus, {
        portnetRef: checkpoint.portnetRef,
      });
    }

    if (!portnetPage) {
      sendProgress(id, "captcha-waiting");
      portnetPage = await ensurePortnetSession();
    }

    await monitorPendingPortnetRequests([acheminement], portnetPage);
    const finalState = getAutomationState(folderPath);
    if (finalState?.phase === "badr_done") {
      return { success: true, declarationRef: finalState.badrRef };
    }

    return {
      success: false,
      error: finalState?.error || "Processing did not complete",
    };
  } catch (err) {
    updateAutomationState(folderPath, { phase: "error", error: err.message });
    sendLog("error", "Automation", `Failed for "${id}": ${err.message}`);
    sendProgress(id, "error", { error: err.message });
    return { success: false, error: err.message };
  }
}

async function runAllAutomationTasks(acheminements) {
  let portnetPage = null;

  try {
    const toProcess = acheminements.filter((a) => !a.refMismatch);
    const needsPortnet = toProcess.some((ach) => {
      const phase = getAutomationState(ach.folderPath)?.phase;
      return !["badr_done", "partiel_skip", "weight_mismatch"].includes(phase);
    });

    if (needsPortnet) {
      portnetPage = await ensurePortnetSession();
    }

    for (const ach of toProcess) {
      const checkpoint = getAutomationState(ach.folderPath);
      const hasSubmittedPortnet = !!checkpoint?.portnetRef;
      const hasAcceptedPortnet = !!checkpoint?.badrRef;

      if (checkpoint?.phase === "badr_done") {
        sendProgress(ach.id, "done", { declarationRef: checkpoint.badrRef });
        continue;
      }
      if (hasSubmittedPortnet && !hasAcceptedPortnet) {
        const resumeStatus =
          checkpoint.phase === "portnet_submitted"
            ? "portnet-submitted"
            : "monitoring-portnet";
        sendLog(
          "info",
          "Automation",
          `Skipping submit for "${ach.id}" — already submitted (${checkpoint.portnetRef}), going directly to monitoring.`,
        );
        sendProgress(ach.id, resumeStatus, {
          portnetRef: checkpoint.portnetRef,
        });
        continue;
      }
      if (hasAcceptedPortnet) {
        sendProgress(ach.id, "portnet-accepted", {
          declarationRef: checkpoint.badrRef,
        });
        await finalizeAcceptedOnBadr(ach, checkpoint.badrRef);
        continue;
      }

      await runAutomationTask(ach, {
        stopAfterSubmit: true,
        sharedPortnetPage: portnetPage,
      });
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (portnetPage) {
      await monitorPendingPortnetRequests(toProcess, portnetPage);
    }

    return { success: true };
  } catch (err) {
    sendLog("error", "Automation", `Batch run failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── IPC: Open folder dialog ───────────────────────────────────────────────────
ipcMain.handle("dialog:openFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Sélectionner le dossier des acheminements",
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── IPC: Scan folder for acheminements ────────────────────────────────────────
ipcMain.handle("folder:scan", async (_event, folderPath) => {
  if (!folderPath || !fs.existsSync(folderPath)) return [];

  sendLog("info", "Scan", `Dossier acheminements: ${folderPath}`);

  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const acheminements = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(folderPath, entry.name);
    const files = fs
      .readdirSync(dirPath)
      .filter((f) => f.toLowerCase().endsWith(".pdf"));

    const mawb = pickMawbPdf(files);
    const mawbRef = mawb ? extractLotReferenceFromFilename(mawb) || null : null;
    const manifeste = pickManifestPdf(files);
    const manifesteRef = manifeste
      ? extractLotReferenceFromFilename(manifeste) || null
      : null;

    let manifestPdfExtract = null;
    if (manifeste) {
      const manifestPath = path.join(dirPath, manifeste);
      try {
        manifestPdfExtract =
          await extractManifestMetricsFromPdfFile(manifestPath);
        if (manifestPdfExtract?.ok) {
          const bits = [
            manifestPdfExtract.refNumber &&
              `réf ${manifestPdfExtract.refNumber}`,
            manifestPdfExtract.nombreContenant &&
              `${manifestPdfExtract.nombreContenant} colis`,
            manifestPdfExtract.poidTotal &&
              `${manifestPdfExtract.poidTotal} kg`,
            manifestPdfExtract.currency &&
              `devise ${manifestPdfExtract.currency}`,
            manifestPdfExtract.totalValue &&
              `valeur ${manifestPdfExtract.totalValue}`,
          ]
            .filter(Boolean)
            .join(", ");
          sendLog(
            "info",
            "Manifeste",
            `[${entry.name}] PDF "${manifeste}" — extrait${bits ? `: ${bits}` : ""}`,
          );
          if (!manifestPdfExtract.totalValue) {
            sendLog(
              "warn",
              "Manifeste",
              `[${entry.name}] Valeur totale (2ᵉ des trois totaux en bas du tableau) absente du texte PDF — saisie manuelle ou PDF image uniquement.`,
            );
          }
        } else {
          sendLog(
            "warn",
            "Manifeste",
            `[${entry.name}] PDF "${manifeste}" — pas d’en-tête exploitable (${manifestPdfExtract?.error || "inconnu"})`,
          );
        }
      } catch (e) {
        manifestPdfExtract = { ok: false, error: String(e?.message || e) };
        sendLog(
          "error",
          "Manifeste",
          `[${entry.name}] lecture PDF échouée: ${manifestPdfExtract.error}`,
        );
      }
    }

    if (
      manifestPdfExtract &&
      !manifestPdfExtract.ok &&
      mawb &&
      mawb !== manifeste
    ) {
      try {
        const mawbPath = path.join(dirPath, mawb);
        const fromMawb = await extractManifestMetricsFromPdfFile(mawbPath);
        if (fromMawb.ok) {
          manifestPdfExtract = fromMawb;
          sendLog(
            "info",
            "Manifeste",
            `[${entry.name}] en-tête lu depuis le PDF MAWB "${mawb}" (le manifeste seul n’a pas de texte exploitable)`,
          );
        }
      } catch (e) {
        /* ignore */
      }
    }

    let refNumber = mawbRef || manifesteRef || "";
    if (manifestPdfExtract?.ok && manifestPdfExtract.refNumber) {
      refNumber =
        refNumber || normalizeLotReference(manifestPdfExtract.refNumber) || "";
    }

    const filenameMismatch = !!(
      mawbRef &&
      manifesteRef &&
      mawbRef !== manifesteRef
    );
    const pdfVsFilenameMismatch = !!(
      manifestPdfExtract?.ok &&
      manifestPdfExtract.refNumber &&
      refNumber &&
      normalizeLotReference(manifestPdfExtract.refNumber) !==
        normalizeLotReference(refNumber)
    );
    const refMismatch = filenameMismatch || pdfVsFilenameMismatch;

    const saved = readAcheminementFile(dirPath);

    const mergedNombre = pickSavedOrExtracted(
      saved.nombreContenant,
      manifestPdfExtract?.ok ? manifestPdfExtract.nombreContenant : null,
      "",
    );
    const mergedPoids = pickSavedOrExtracted(
      saved.poidTotal,
      manifestPdfExtract?.ok ? manifestPdfExtract.poidTotal : null,
      "",
    );
    // Currency & totalValue: PDF extraction wins over saved (PDF is source of truth)
    const mergedCurrency = pickSavedOrExtracted(
      manifestPdfExtract?.ok ? manifestPdfExtract.currency : null,
      saved.currency,
      "MAD",
    );
    const mergedTotalValue = pickSavedOrExtracted(
      manifestPdfExtract?.ok ? manifestPdfExtract.totalValue : null,
      saved.totalValue,
      "",
    );

    acheminements.push({
      id: entry.name,
      name: entry.name,
      folderPath: dirPath,
      manifeste,
      mawb,
      refNumber,
      refMismatch,
      manifestPdfExtract,
      files,
      scelle1: saved.scelle1 ?? "",
      scelle2: saved.scelle2 ?? "",
      nombreContenant: mergedNombre,
      poidTotal: mergedPoids,
      sequenceNumber: saved.sequenceNumber ?? "",
      lieuChargement: saved.lieuChargement ?? "",
      currency: mergedCurrency,
      totalValue: mergedTotalValue,
      partiel: saved.partiel ?? false,
      automationState: saved[CHECKPOINT_KEY] ?? null,
    });
  }

  return acheminements;
});

// ── IPC: Persist user-input fields for one acheminement ──────────────────────
const SAVED_FIELDS = [
  "scelle1",
  "scelle2",
  "nombreContenant",
  "poidTotal",
  "sequenceNumber",
  "lieuChargement",
  "currency",
  "totalValue",
  "partiel",
];
ipcMain.handle("acheminement:save", (_event, { folderPath: fp, data }) => {
  try {
    const existing = readAcheminementFile(fp);
    const toSave = Object.fromEntries(
      SAVED_FIELDS.map((k) => [k, data[k] ?? null]),
    );
    if (existing[CHECKPOINT_KEY]) {
      toSave[CHECKPOINT_KEY] = existing[CHECKPOINT_KEY];
    }
    writeAcheminementFile(fp, toSave);
  } catch (e) {
    console.error("[acheminement:save] Failed:", e.message);
  }
  return { ok: true };
});

// ── IPC: Open file in OS explorer ────────────────────────────────────────────
ipcMain.handle("shell:openPath", async (_event, filePath) => {
  await shell.openPath(filePath);
});

// ── IPC: Run automation for one acheminement ──────────────────────────────────
ipcMain.handle("automation:run", async (_event, acheminement) => {
  return await runAutomationTask(acheminement);
});

ipcMain.handle("automation:run-all", async (_event, acheminements) => {
  return await runAllAutomationTasks(acheminements || []);
});

ipcMain.handle("automation:close-sessions", async () => {
  await closeSharedSessions();
  return { success: true };
});

app.on("before-quit", async () => {
  await closeSharedSessions();
});
