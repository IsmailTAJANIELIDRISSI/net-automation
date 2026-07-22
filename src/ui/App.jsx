import React, { useState, useEffect, useCallback, useRef } from "react";
import Header from "./components/Header.jsx";
import AcheminementCard from "./components/AcheminementCard.jsx";
import LogPanel from "./components/LogPanel.jsx";
import { getMissingRequiredFields } from "./requiredFields.js";

/** Keep user input unless blank — otherwise new scan values apply (acheminement.json can store ""). */
function preferNonEmptyPrev(prev, fromScan) {
  if (prev != null && String(prev).trim() !== "") return prev;
  return fromScan ?? "";
}

/**
 * Phases "Tout lancer" must NOT (re)launch: already finished, waiting on a human
 * (signature / next vol), needs a manual fix (weight), or errored (don't auto-retry).
 */
const NON_LAUNCHABLE_PHASES = new Set([
  "badr_done",
  "partiel_done",
  "partiel_skip",
  "partiel_waiting_signature",
  "partiel_waiting_lots",
  "weight_mismatch",
  "error",
]);

/** LTAs ready to be launched now: complete fields, no ref mismatch, not terminal/waiting. */
function computeLaunchable(list) {
  return (list || []).filter((a) => {
    if (a.refMismatch) return false;
    if (NON_LAUNCHABLE_PHASES.has(a.automationState?.phase)) return false;
    return getMissingRequiredFields(a).length === 0;
  });
}

export default function App() {
  // ── State ─────────────────────────────────────────────────────────────────
  const [folderPath, setFolderPath] = useState(null);
  const [acheminements, setAcheminements] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [logs, setLogs] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [logPanelOpen, setLogPanelOpen] = useState(true);
  // Set of card ids currently running a shipper MAWB extraction
  const [shipperLoadingIds, setShipperLoadingIds] = useState(new Set());

  const checkpointToStatus = (state) => {
    switch (state?.phase) {
      case "portnet_submitted":
        return "portnet-submitted";
      case "portnet_accepted":
        return "portnet-accepted";
      case "partiel_waiting_signature":
        return "partiel-waiting-signature";
      case "badr_done":
      case "partiel_done":
        return "done";
      case "weight_mismatch":
        return "weight-mismatch";
      case "partiel_skip":
        return "partiel-skip";
      case "waiting_manifest":
        return "waiting-manifest";
      case "error":
        return "error";
      default:
        return "idle";
    }
  };

  const statusesFromScan = (items) =>
    Object.fromEntries(
      items
        .filter((a) => a.automationState)
        .map((a) => [
          a.id,
          {
            acheminementId: a.id,
            status: checkpointToStatus(a.automationState),
            declarationRef: a.automationState?.badrRef,
            error: a.automationState?.error,
            portnetRef: a.automationState?.portnetRef,
            nextVol:
              a.automationState?.nextVol ??
              a.automationState?.poidsMismatch?.nextVol,
          },
        ]),
    );

  // Mirror of acheminements kept in a ref so handleChange can read latest without stale closure
  const achRef = useRef([]);
  // True while a batch (submit → monitor) is running. A launch during this window
  // is handed to the running monitor (backend queues it) instead of starting a
  // second concurrent batch. A ref (not state) so handlers read it synchronously.
  const runInProgressRef = useRef(false);
  useEffect(() => {
    achRef.current = acheminements;
  }, [acheminements]);

  // ── Subscribe to IPC events on mount ──────────────────────────────────────
  useEffect(() => {
    const unsubLog = window.api.onLog((entry) => {
      setLogs((prev) => [...prev, entry]);
    });

    const unsubProgress = window.api.onProgress((payload) => {
      const { acheminementId, status, sequenceNumber, lieuChargement } =
        payload;
      setStatuses((prev) => ({ ...prev, [acheminementId]: payload }));

      // If the backend discovered sequence/lieuChargement, push them to the card.
      if (sequenceNumber || lieuChargement) {
        setAcheminements((prev) =>
          prev.map((a) => {
            if (a.id !== acheminementId) return a;
            const updated = {
              ...a,
              ...(sequenceNumber ? { sequenceNumber } : {}),
              ...(lieuChargement ? { lieuChargement } : {}),
            };
            window.api.saveAcheminement(a.folderPath, updated).catch(() => {});
            return updated;
          }),
        );
      }
    });

    return () => {
      unsubLog?.();
      unsubProgress?.();
    };
  }, []);

  // ── Helper: offer to delete done folders, re-scan if any deleted ──────────
  const offerDeleteDone = useCallback(async (scanned, currentFolderPath) => {
    const doneFolders = scanned
      .filter((a) => {
        const phase = a.automationState?.phase;
        return phase === "badr_done" || phase === "partiel_done";
      })
      .map((a) => a.folderPath)
      .filter(Boolean);

    if (doneFolders.length === 0) return scanned;

    const { deleted } = await window.api.deleteDoneFolders(doneFolders);
    if (deleted.length === 0) return scanned;

    addLog(
      "info",
      "UI",
      `${deleted.length} dossier(s) supprimé(s) — actualisation…`,
    );
    const refreshed = await window.api.scanFolder(currentFolderPath);
    return refreshed;
  }, []);

  // ── Select folder and scan ────────────────────────────────────────────────
  const handleSelectFolder = useCallback(async () => {
    const selected = await window.api.selectFolder();
    if (!selected) return;

    setFolderPath(selected);
    setLogs([]);

    const scanned = await window.api.scanFolder(selected);
    const final = await offerDeleteDone(scanned, selected);
    setAcheminements(final);
    setStatuses(statusesFromScan(final));
  }, [offerDeleteDone]);

  // ── Refresh (re-scan current folder) ──────────────────────────────────────
  const handleRefresh = useCallback(async () => {
    if (!folderPath) return;
    const scanned = await window.api.scanFolder(folderPath);
    setStatuses((prev) => ({ ...statusesFromScan(scanned), ...prev }));
    // Preserve user-edited field values
    setAcheminements((prev) => {
      const prevMap = Object.fromEntries(prev.map((a) => [a.id, a]));
      return scanned.map((a) => ({
        ...a,
        scelle1: prevMap[a.id]?.scelle1 ?? a.scelle1,
        scelle2: prevMap[a.id]?.scelle2 ?? a.scelle2,
        nombreContenant: preferNonEmptyPrev(
          prevMap[a.id]?.nombreContenant,
          a.nombreContenant,
        ),
        poidTotal: preferNonEmptyPrev(prevMap[a.id]?.poidTotal, a.poidTotal),
        sequenceNumber: prevMap[a.id]?.sequenceNumber ?? a.sequenceNumber,
        lieuChargement: prevMap[a.id]?.lieuChargement ?? a.lieuChargement,
        currency:
          preferNonEmptyPrev(prevMap[a.id]?.currency, a.currency) || "MAD",
        totalValue: preferNonEmptyPrev(prevMap[a.id]?.totalValue, a.totalValue),
        manifestPdfExtract:
          a.manifestPdfExtract ?? prevMap[a.id]?.manifestPdfExtract,
        automationState: a.automationState ?? prevMap[a.id]?.automationState,
      }));
    });
  }, [folderPath]);

  // Backend found a new LTA folder mid-run (during Portnet monitoring) → re-scan
  // so its card shows up live, without waiting for the batch to finish.
  useEffect(() => {
    const unsub = window.api.onAcheminementsChanged(() => {
      addLog("info", "UI", "Nouveau dossier détecté — actualisation de la liste…");
      handleRefresh();
    });
    return () => unsub?.();
  }, [handleRefresh]);

  // ── Field onChange (per-card) ──────────────────────────────────────────────
  const handleChange = useCallback((id, key, value) => {
    setAcheminements((prev) =>
      prev.map((a) => (a.id === id ? { ...a, [key]: value } : a)),
    );
    // Persist to acheminement.json inside the folder so data survives restarts
    const ach = achRef.current.find((a) => a.id === id);
    if (ach) {
      // If toggling partiel ON and no shipperName yet, show skeleton loading
      const willExtract =
        key === "partiel" && value === true && !ach.shipperName;
      if (willExtract) {
        setShipperLoadingIds((prev) => new Set([...prev, id]));
      }
      window.api
        .saveAcheminement(ach.folderPath, { ...ach, [key]: value })
        .then((result) => {
          // If saving partiel=true triggered extraction, update the fields
          if (
            result?.shipperName ||
            result?.mawbCurrency ||
            result?.fretValue
          ) {
            setAcheminements((prev) =>
              prev.map((a) => {
                if (a.id !== id) return a;
                const patch = {};
                if (result.shipperName) patch.shipperName = result.shipperName;
                if (result.mawbCurrency)
                  patch.mawbCurrency = result.mawbCurrency;
                if (result.fretValue) patch.fretValue = result.fretValue;
                return { ...a, ...patch };
              }),
            );
          }
        })
        .catch(() => {})
        .finally(() => {
          if (willExtract) {
            setShipperLoadingIds((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
        });
    }
  }, []);

  // ── Delete a single done LTA folder ────────────────────────────────────
  const handleDelete = useCallback(
    async (ach) => {
      const { deleted } = await window.api.deleteDoneFolders([ach.folderPath]);
      if (deleted.length > 0) {
        addLog("info", "UI", `Dossier supprimé: ${ach.name}`);
        if (folderPath) {
          const scanned = await window.api.scanFolder(folderPath);
          setAcheminements(scanned);
          // Merge so the LIVE statuses of LTAs still processing aren't reset by
          // the scan-derived ones (a done card can be deleted mid-run).
          setStatuses((prev) => ({ ...statusesFromScan(scanned), ...prev }));
        }
      }
    },
    [folderPath],
  );

  // ── Declare scellés for partiel DUM (after manual signature) ─────────────
  const handleDeclareScelles = useCallback(async (ach, signedSerie) => {
    setIsRunning(true);
    setStatuses((prev) => ({
      ...prev,
      [ach.id]: { acheminementId: ach.id, status: "running" },
    }));
    addLog(
      "info",
      "Scellés",
      `Déclaration scellés pour ${ach.name} — série: ${signedSerie}`,
    );
    try {
      const result = await window.api.declareScelles(
        ach.folderPath,
        signedSerie,
      );
      if (!result.ok) {
        addLog("error", "Scellés", `Échec: ${result.error}`);
      }
    } catch (err) {
      setStatuses((prev) => ({
        ...prev,
        [ach.id]: {
          acheminementId: ach.id,
          status: "error",
          error: err.message,
        },
      }));
      addLog("error", "Scellés", `Exception: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  }, []);

  // ── Run one acheminement ───────────────────────────────────────────────────
  const handleRun = useCallback(async (ach) => {
    // A batch is already running → hand this LTA to the running monitor instead
    // of starting a concurrent one (backend queues it; browsers stay open).
    if (runInProgressRef.current) {
      const res = await window.api.runAutomation(ach);
      if (res?.queued) {
        addLog(
          "info",
          "UI",
          `🔄 ${ach.name} ajouté au traitement en cours (sessions ouvertes).`,
        );
      } else if (res?.busy) {
        addLog("warn", "UI", "Soumission en cours — réessayez dans un instant.");
      }
      return;
    }

    setIsRunning(true);
    runInProgressRef.current = true;
    setStatuses((prev) => ({
      ...prev,
      [ach.id]: { acheminementId: ach.id, status: "running" },
    }));

    addLog("info", "UI", `Lancement pour: ${ach.name}`);

    try {
      const result = await window.api.runAutomation(ach);
      if (!result.success) {
        if (result.skipped) {
          // Not a real failure — e.g. BADR shows 2 lots so it's a DS Partiel.
          const msg =
            result.reason === "partiel"
              ? `${ach.name}: DS Partiel détecté — cochez « Partiel » pour traiter ce LTA via le flux DUM Normale Partiel.`
              : `${ach.name}: ignoré${result.reason ? ` (${result.reason})` : ""}`;
          addLog("warn", "UI", msg);
        } else {
          // status is updated via IPC progress event
          addLog("error", "UI", `Échec: ${result.error || "raison inconnue"}`);
        }
      }
    } catch (err) {
      setStatuses((prev) => ({
        ...prev,
        [ach.id]: {
          acheminementId: ach.id,
          status: "error",
          error: err.message,
        },
      }));
      addLog("error", "UI", `Exception: ${err.message}`);
    } finally {
      setIsRunning(false);
      runInProgressRef.current = false;
    }
  }, []);

  // ── Run all (sequential) ──────────────────────────────────────────────────
  const handleRunAll = useCallback(async () => {
    // Launchable LTAs right now (complete fields, not done/waiting/error).
    const pending = computeLaunchable(acheminements);

    for (const a of acheminements) {
      if (a.refMismatch) continue;
      const missing = getMissingRequiredFields(a);
      if (missing.length > 0) {
        addLog(
          "warn",
          "UI",
          `${a.name}: ignoré — champs obligatoires manquants : ${missing.join(", ")}`,
        );
      }
    }

    if (pending.length === 0) {
      addLog(
        "info",
        "UI",
        "Aucun LTA complet à traiter (tous ignorés ou déjà traités).",
      );
      return;
    }

    // A batch is already running (e.g. polling Portnet for Acceptée). Hand the
    // launchable LTAs to the running monitor — it injects the ones not already
    // submitted/done, so only newly-edited LTAs get processed, browsers stay open.
    if (runInProgressRef.current) {
      const res = await window.api.runAllAutomation(pending);
      if (res?.queued) {
        addLog(
          "info",
          "UI",
          "🔄 LTA(s) ajouté(s) au traitement en cours — les LTAs déjà traités sont ignorés (sessions ouvertes).",
        );
      } else if (res?.busy) {
        addLog("warn", "UI", "Soumission en cours — réessayez dans un instant.");
      }
      return;
    }

    setIsRunning(true);
    runInProgressRef.current = true;
    addLog("info", "UI", "Lancement batch: soumission + suivi Portnet…");
    try {
      const result = await window.api.runAllAutomation(pending);
      if (!result.success) {
        addLog("error", "UI", `Échec batch: ${result.error || "inconnu"}`);
      }

      // Batch done — offer to delete fully-done folders. Any folder added during
      // the run stays as an editable, un-launched card for the operator.
      if (folderPath) {
        const scanned = await window.api.scanFolder(folderPath);
        const doneFolders = scanned
          .filter((a) => {
            const p = a.automationState?.phase;
            return p === "badr_done" || p === "partiel_done";
          })
          .map((a) => a.folderPath)
          .filter(Boolean);
        if (doneFolders.length > 0) {
          const { deleted } = await window.api.deleteDoneFolders(doneFolders);
          if (deleted.length > 0) {
            addLog(
              "info",
              "UI",
              `${deleted.length} dossier(s) supprimé(s) — actualisation…`,
            );
            const rescanned = await window.api.scanFolder(folderPath);
            setAcheminements(rescanned);
            setStatuses(statusesFromScan(rescanned));
          }
        }
      }
    } catch (err) {
      addLog("error", "UI", `Exception batch: ${err.message}`);
    } finally {
      setIsRunning(false);
      runInProgressRef.current = false;
    }
  }, [acheminements, folderPath]);

  // ── Helper: add a local log entry ─────────────────────────────────────────
  const addLog = (level, context, message) => {
    setLogs((prev) => [
      ...prev,
      { level, context, message, ts: new Date().toISOString() },
    ]);
  };

  // ── Layout ────────────────────────────────────────────────────────────────
  const doneCount = Object.values(statuses).filter(
    (s) => s.status === "done",
  ).length;
  const errorCount = Object.values(statuses).filter(
    (s) => s.status === "error" || s.status === "weight-mismatch",
  ).length;
  const pendingCount = acheminements.length - doneCount - errorCount;

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-slate-950">
      {/* ── Title bar / Header ─────────────────────────────────────────────── */}
      <Header
        folderPath={folderPath}
        achCount={acheminements.length}
        onSelectFolder={handleSelectFolder}
        isRunning={isRunning}
      />

      {/* ── Toolbar strip ─────────────────────────────────────────────────── */}
      {acheminements.length > 0 && (
        <div
          className="flex items-center justify-between px-5 py-2 bg-slate-900/50
                        border-b border-slate-800 flex-shrink-0"
        >
          {/* Stats */}
          <div className="flex items-center gap-4 text-xs text-slate-500">
            <span>{acheminements.length} acheminements</span>
            {doneCount > 0 && (
              <span className="text-emerald-500">✓ {doneCount} terminés</span>
            )}
            {errorCount > 0 && (
              <span className="text-red-500">✗ {errorCount} erreurs</span>
            )}
            {pendingCount > 0 && isRunning && (
              <span className="text-blue-400 animate-pulse">
                {pendingCount} en attente…
              </span>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={isRunning}
              className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700
                         text-slate-400 hover:text-slate-200 border border-slate-700
                         disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              ↺ Actualiser
            </button>
            <button
              onClick={handleRunAll}
              disabled={acheminements.length === 0}
              title={
                isRunning
                  ? "Ajoute les nouveaux LTA complets au traitement en cours (sessions ouvertes ; les LTAs déjà traités sont ignorés)"
                  : undefined
              }
              className="text-xs px-4 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600
                         text-white font-semibold shadow-md
                         disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {isRunning ? "➕ Ajouter au traitement" : "▶ Tout lancer"}
            </button>
            <button
              onClick={() => setLogPanelOpen((v) => !v)}
              className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700
                         text-slate-400 hover:text-slate-200 border border-slate-700 transition-all"
            >
              {logPanelOpen ? "Masquer logs" : "Afficher logs"}
              {logs.length > 0 && (
                <span className="ml-1.5 bg-slate-700 text-slate-300 rounded-full px-1.5 py-0.5 text-xs">
                  {logs.length}
                </span>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex min-h-0">
        {/* Left: cards grid */}
        <div
          className={`flex-1 overflow-y-auto p-4 ${logPanelOpen ? "pr-2" : ""}`}
        >
          {acheminements.length === 0 ? (
            /* Empty state */
            <div className="flex flex-col items-center justify-center h-full text-center gap-4">
              <div
                className="w-16 h-16 rounded-2xl bg-slate-800 border border-slate-700
                              flex items-center justify-center text-3xl"
              >
                📂
              </div>
              <div>
                <p className="text-slate-300 font-semibold mb-1">
                  Aucun acheminement trouvé
                </p>
                <p className="text-slate-500 text-sm max-w-xs">
                  Sélectionnez un dossier contenant des sous-dossiers
                  d'acheminements, chacun avec un Manifeste et un MAWB/LTA en
                  PDF.
                </p>
              </div>
              <button
                onClick={handleSelectFolder}
                className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white
                           rounded-xl font-medium text-sm shadow-lg transition-all"
              >
                Choisir un dossier
              </button>
            </div>
          ) : (
            <div
              className="grid gap-4"
              style={{
                gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              }}
            >
              {acheminements.map((ach) => (
                <AcheminementCard
                  key={ach.id}
                  ach={ach}
                  status={statuses[ach.id]?.status ?? "idle"}
                  error={statuses[ach.id]?.error}
                  nextVol={statuses[ach.id]?.nextVol}
                  isGlobalRunning={isRunning}
                  shipperLoading={shipperLoadingIds.has(ach.id)}
                  onChange={handleChange}
                  onRun={handleRun}
                  onDelete={handleDelete}
                  onDeclareScelles={handleDeclareScelles}
                />
              ))}
            </div>
          )}
        </div>

        {/* Right: log panel */}
        {logPanelOpen && (
          <div className="w-[420px] flex-shrink-0 p-4 pl-2 flex flex-col min-h-0">
            <LogPanel logs={logs} onClear={() => setLogs([])} />
          </div>
        )}
      </div>
    </div>
  );
}
