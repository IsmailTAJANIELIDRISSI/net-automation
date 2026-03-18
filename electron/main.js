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

function writeAcheminementFile(folderPath, data) {
  const savePath = path.join(folderPath, "acheminement.json");
  fs.writeFileSync(savePath, JSON.stringify(data, null, 2), "utf8");
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

async function prepareLotAndWeightCheck(acheminement) {
  const {
    id,
    folderPath,
    refNumber,
    poidTotal,
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

  const BADRConnection = require("../src/badr/badrConnection");
  const BADRLotLookup = require("../src/badr/badrLotLookup");
  const BADRPreapurement = require("../src/badr/badrPreapurement");

  let badrConn = null;
  let lotInfo = null;

  try {
    badrConn = new BADRConnection();

    if (!sequenceNumber || sequenceNumber.trim() === "") {
      sendLog("info", "BADR", "No sequence number – looking up in BADR…");
      await badrConn.connect();

      const lotLookup = new BADRLotLookup(badrConn.page);
      await lotLookup.openLotPopup();
      lotInfo = await lotLookup.searchLot(refNumber);
      await lotLookup.close();

      if (lotInfo.isEmpty) {
        updateAutomationState(folderPath, {
          phase: "error",
          error: "Pas encours manifest",
        });
        sendLog(
          "warn",
          "BADR",
          `Pas encours manifest pour ${refNumber} – email envoyé`,
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
          `DS Partiel détecté pour ${refNumber} (${lotInfo.rowCount} lignes) – ignoré`,
        );
        sendProgress(id, "partiel-skip");
        return { success: false, skipped: true, reason: "partiel" };
      }

      sendLog(
        "info",
        "BADR",
        `Lot trouvé: ${lotInfo.declarationRef} | Lieu: ${lotInfo.lieuChargement}`,
      );

      const seqDisplay =
        String(parseInt(lotInfo.sequenceNum, 10)) +
        (lotInfo.cle ? ` ${lotInfo.cle}` : "");
      lotInfo.sequenceNum = seqDisplay;

      try {
        const existing = readAcheminementFile(folderPath);
        existing.sequenceNumber = seqDisplay;
        existing.lieuChargement = lotInfo.lieuChargement || "";
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

      await badrConn.connect();
      lotInfo = {
        declarationRef: refNumber
          ? `301-000-${new Date().getFullYear()}-${serie}-${cle}`
          : "",
        bureau: "301",
        regime: "000",
        annee: String(new Date().getFullYear()),
        serie,
        cle,
        sequenceNum: `${String(parseInt(serie, 10))}${cle ? ` ${cle}` : ""}`,
        lieuChargement: lieuChargement || "",
      };
    }

    sendLog("info", "BADR", "Checking poids brut via Préapurement DS…");
    const preap = new BADRPreapurement(badrConn.page);
    const poidsInfo = await preap.getPoidsBrut(lotInfo, refNumber);

    const poidsBadr = parseFloat(String(poidsInfo.poidsBrut).replace(",", "."));
    const poidsUser = parseFloat(String(poidTotal).replace(",", "."));

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
          `[TODO MAIL] Écart poids critique pour ${refNumber}: ${diff.toFixed(2)} kg (BADR=${poidsBadr}, SAISIE=${poidsUser})`,
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
          `[TODO MAIL] Écart poids > 5kg pour ${refNumber}: ${diff.toFixed(2)} kg (BADR=${poidsBadr}, SAISIE=${poidsUser})`,
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
      userWeight: poidTotal,
    });

    return { success: true, lotInfo };
  } finally {
    if (badrConn) await badrConn.disconnect().catch(() => {});
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
  await dsCombine.fillEntete({
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

  sendLog("info", "Portnet", `Submitting request for "${id}"…`);
  sendProgress(id, "submitting-portnet");

  const portnetRef = await dsCombine.submitRequest(lotInfo.sequenceNum);
  updateAutomationState(folderPath, {
    phase: "portnet_submitted",
    portnetRef,
    submittedAt: new Date().toISOString(),
    attempts: 0,
    lotInfo,
    error: null,
  });
  sendProgress(id, "portnet-submitted", { portnetRef });
  sendLog("info", "Portnet", `Request submitted for "${id}" (${portnetRef})`);

  return { success: true, portnetRef };
}

async function finalizeAcceptedOnBadr(acheminement, badrRef) {
  const { id, folderPath, scelle1, scelle2 } = acheminement;
  const BADRConnection = require("../src/badr/badrConnection");
  const BADRDsCombineFinalize = require("../src/badr/badrDsCombineFinalize");

  let badrConn = null;
  try {
    badrConn = new BADRConnection();
    await badrConn.connect();

    sendLog("info", "BADR", `Proceeding to finalize on BADR for "${id}"...`);
    sendProgress(id, "badr-downloading", { declarationRef: badrRef });

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
  } finally {
    if (badrConn) await badrConn.disconnect().catch(() => {});
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

  const maxAttempts = 240;
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

      const { found, statusText, refDsRaw, createdAtRaw } =
        await dsCombine.getConsultationStatus(state.portnetRef, {
          submittedAt: state.submittedAt || null,
          excludeRefDs: Array.from(claimedAcceptedRefs),
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

      sendLog(
        "info",
        "Portnet",
        `Current status for ${state.portnetRef}: ${statusText}`,
      );

      if (statusText === "Acceptée" || statusText === "Acceptee") {
        const shortRef = String(refDsRaw || "")
          .substring(10)
          .replace(/^0+/, "");

        if (!shortRef) {
          sendLog(
            "warn",
            "Portnet",
            `Acceptée found for ${state.portnetRef} but Réference DS is still empty/undefined (createdAt=${createdAtRaw || "n/a"}). Waiting next poll...`,
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
        sendProgress(ach.id, "portnet-accepted", { declarationRef: shortRef });
        pending.delete(ach.id);
        await finalizeAcceptedOnBadr(ach, shortRef);
      } else if (statusText === "Rejetée" || statusText === "Rejetee") {
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
  }
}

async function runAutomationTask(
  acheminement,
  { stopAfterSubmit = false, sharedPortnetPage = null } = {},
) {
  const { id, folderPath } = acheminement;
  const PortnetLogin = require("../src/portnet/portnetLogin");

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

  let ownPortnetApp = null;
  let portnetPage = sharedPortnetPage;

  try {
    if (!hasSubmittedPortnet) {
      const prep = await prepareLotAndWeightCheck(acheminement);
      if (!prep.success) return prep;

      if (!portnetPage) {
        ownPortnetApp = new PortnetLogin();
        sendLog("info", "Portnet", "Launching Portnet login…");
        sendProgress(id, "captcha-waiting");
        sendLog(
          "info",
          "Portnet",
          ">>> Résolvez le CAPTCHA dans la fenêtre du navigateur <<<",
        );
        portnetPage = await ownPortnetApp.login();
        sendLog("info", "Portnet", "Login confirmed.");
      }

      const submitResult = await submitPortnetPhase(
        acheminement,
        prep.lotInfo,
        portnetPage,
      );
      if (!submitResult.success || stopAfterSubmit) {
        return submitResult;
      }
    } else {
      sendLog(
        "info",
        "Automation",
        `Checkpoint found for "${id}" — request already submitted (${checkpoint.portnetRef}), skipping precheck + re-send.`,
      );
      sendProgress(id, "portnet-submitted", {
        portnetRef: checkpoint.portnetRef,
      });
    }

    if (!portnetPage) {
      ownPortnetApp = new PortnetLogin();
      sendLog("info", "Portnet", "Launching Portnet login…");
      sendProgress(id, "captcha-waiting");
      sendLog(
        "info",
        "Portnet",
        ">>> Résolvez le CAPTCHA dans la fenêtre du navigateur <<<",
      );
      portnetPage = await ownPortnetApp.login();
      sendLog("info", "Portnet", "Login confirmed.");
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
  } finally {
    if (ownPortnetApp) await ownPortnetApp.close().catch(() => {});
  }
}

async function runAllAutomationTasks(acheminements) {
  const PortnetLogin = require("../src/portnet/portnetLogin");
  let portnetApp = null;
  let portnetPage = null;

  try {
    const toProcess = acheminements.filter((a) => !a.refMismatch);
    const needsPortnet = toProcess.some((ach) => {
      const phase = getAutomationState(ach.folderPath)?.phase;
      return !["badr_done", "partiel_skip", "weight_mismatch"].includes(phase);
    });

    if (needsPortnet) {
      portnetApp = new PortnetLogin();
      sendLog("info", "Portnet", "Launching Portnet login for batch run…");
      sendLog(
        "info",
        "Portnet",
        ">>> Résolvez le CAPTCHA dans la fenêtre du navigateur <<<",
      );
      portnetPage = await portnetApp.login();
      sendLog("info", "Portnet", "Batch Portnet login confirmed.");
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
        sendLog(
          "info",
          "Automation",
          `Skipping submit for "${ach.id}" — already submitted (${checkpoint.portnetRef}), going directly to monitoring.`,
        );
        sendProgress(ach.id, "portnet-submitted", {
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
  } finally {
    if (portnetApp) await portnetApp.close().catch(() => {});
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

  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const acheminements = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(folderPath, entry.name);
    const files = fs
      .readdirSync(dirPath)
      .filter((f) => f.toLowerCase().endsWith(".pdf"));

    let manifeste = null;
    let mawb = null;
    let mawbRef = null;
    let manifesteRef = null;

    for (const file of files) {
      const lower = file.toLowerCase();
      // MAWB or LTA detection
      if (lower.includes("mawb") || lower.includes("lta")) {
        mawb = file;
        // Extract ref: digits-digits pattern e.g. "607-52839835"
        const match = file.match(/(\d{3}-\d+)/);
        if (match) mawbRef = match[1];
      } else if (lower.includes("manifest") || lower.includes("manifeste")) {
        manifeste = file;
        const match = file.match(/(\d{3}-\d+)/);
        if (match) manifesteRef = match[1];
      }
    }

    // MAWB is the primary ref; detect mismatch between the two files
    const refNumber = mawbRef || manifesteRef;
    const refMismatch = !!(mawbRef && manifesteRef && mawbRef !== manifesteRef);

    // Load previously saved user-input fields from acheminement.json
    const saved = readAcheminementFile(dirPath);

    acheminements.push({
      id: entry.name,
      name: entry.name,
      folderPath: dirPath,
      manifeste,
      mawb,
      refNumber,
      refMismatch,
      files,
      // User-input fields – defaults overridden by saved values
      scelle1: saved.scelle1 ?? "",
      scelle2: saved.scelle2 ?? "",
      nombreContenant: saved.nombreContenant ?? "",
      poidTotal: saved.poidTotal ?? "",
      sequenceNumber: saved.sequenceNumber ?? "",
      lieuChargement: saved.lieuChargement ?? "",
      currency: saved.currency ?? "MAD",
      totalValue: saved.totalValue ?? "",
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
