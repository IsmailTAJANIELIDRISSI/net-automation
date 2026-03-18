import React, { useState, useEffect, useCallback, useRef } from "react";
import Header from "./components/Header.jsx";
import AcheminementCard from "./components/AcheminementCard.jsx";
import LogPanel from "./components/LogPanel.jsx";

export default function App() {
  // ── State ─────────────────────────────────────────────────────────────────
  const [folderPath, setFolderPath] = useState(null);
  const [acheminements, setAcheminements] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [logs, setLogs] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [logPanelOpen, setLogPanelOpen] = useState(true);

  const checkpointToStatus = (state) => {
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
          },
        ]),
    );

  // Mirror of acheminements kept in a ref so handleChange can read latest without stale closure
  const achRef = useRef([]);
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

  // ── Select folder and scan ────────────────────────────────────────────────
  const handleSelectFolder = useCallback(async () => {
    const selected = await window.api.selectFolder();
    if (!selected) return;

    setFolderPath(selected);
    setLogs([]);

    const scanned = await window.api.scanFolder(selected);
    setAcheminements(scanned);
    setStatuses(statusesFromScan(scanned));
  }, []);

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
        nombreContenant: prevMap[a.id]?.nombreContenant ?? a.nombreContenant,
        poidTotal: prevMap[a.id]?.poidTotal ?? a.poidTotal,
        sequenceNumber: prevMap[a.id]?.sequenceNumber ?? a.sequenceNumber,
        lieuChargement: prevMap[a.id]?.lieuChargement ?? a.lieuChargement,
        currency: prevMap[a.id]?.currency ?? a.currency,
        totalValue: prevMap[a.id]?.totalValue ?? a.totalValue,
        automationState: a.automationState ?? prevMap[a.id]?.automationState,
      }));
    });
  }, [folderPath]);

  // ── Field onChange (per-card) ──────────────────────────────────────────────
  const handleChange = useCallback((id, key, value) => {
    setAcheminements((prev) =>
      prev.map((a) => (a.id === id ? { ...a, [key]: value } : a)),
    );
    // Persist to acheminement.json inside the folder so data survives restarts
    const ach = achRef.current.find((a) => a.id === id);
    if (ach) {
      window.api
        .saveAcheminement(ach.folderPath, { ...ach, [key]: value })
        .catch(() => {});
    }
  }, []);

  // ── Run one acheminement ───────────────────────────────────────────────────
  const handleRun = useCallback(async (ach) => {
    setIsRunning(true);
    setStatuses((prev) => ({
      ...prev,
      [ach.id]: { acheminementId: ach.id, status: "running" },
    }));

    addLog("info", "UI", `Lancement pour: ${ach.name}`);

    try {
      const result = await window.api.runAutomation(ach);
      if (!result.success) {
        // status is updated via IPC progress event
        addLog("error", "UI", `Échec: ${result.error}`);
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
    }
  }, []);

  // ── Run all (sequential) ──────────────────────────────────────────────────
  const handleRunAll = useCallback(async () => {
    setIsRunning(true);
    addLog("info", "UI", "Lancement batch: soumission + suivi Portnet…");
    try {
      const pending = acheminements.filter((a) => !a.refMismatch);
      const result = await window.api.runAllAutomation(pending);
      if (!result.success) {
        addLog("error", "UI", `Échec batch: ${result.error || "inconnu"}`);
      }
    } catch (err) {
      addLog("error", "UI", `Exception batch: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  }, [acheminements]);

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
              disabled={isRunning || acheminements.length === 0}
              className="text-xs px-4 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600
                         text-white font-semibold shadow-md
                         disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {isRunning ? "En cours…" : "▶ Tout lancer"}
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
                  isGlobalRunning={isRunning}
                  onChange={handleChange}
                  onRun={handleRun}
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
