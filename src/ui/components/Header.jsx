import React from "react";

/**
 * Application header — sits inside the custom title-bar drag region.
 */
export default function Header({
  folderPath,
  achCount,
  onSelectFolder,
  isRunning,
}) {
  return (
    <header
      className="titlebar-drag flex items-center gap-4 px-5 py-2.5
                        bg-slate-900/90 border-b border-slate-700/50 flex-shrink-0"
      style={{ height: "48px" }}
    >
      {/* ── Brand ──────────────────────────────────────────────────────── */}
      <div className="no-drag flex items-center gap-2.5 select-none">
        <div
          className="w-7 h-7 rounded-lg bg-emerald-600 flex items-center justify-center
                        text-white text-sm font-black shadow"
        >
          M
        </div>
        <div>
          <span className="text-sm font-bold text-white tracking-tight">
            MedAfrica
          </span>
          <span className="text-xs text-slate-500 ml-1.5">DS Combinée</span>
        </div>
      </div>

      {/* ── Divider ────────────────────────────────────────────────────── */}
      <div className="h-5 w-px bg-slate-700 mx-1" />

      {/* ── Folder path & select button ────────────────────────────────── */}
      <div className="no-drag flex items-center gap-3 min-w-0">
        <button
          onClick={onSelectFolder}
          disabled={isRunning}
          className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                     bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white
                     text-xs font-medium border border-slate-700 hover:border-slate-600
                     disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
            />
          </svg>
          Choisir dossier
        </button>

        {folderPath ? (
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="text-xs text-slate-500 truncate max-w-xs"
              title={folderPath}
            >
              {folderPath}
            </span>
            {achCount > 0 && (
              <span
                className="flex-shrink-0 text-xs bg-emerald-900/50 text-emerald-400
                               border border-emerald-700/40 rounded-full px-2 py-0.5"
              >
                {achCount} acheminement{achCount > 1 ? "s" : ""}
              </span>
            )}
          </div>
        ) : (
          <span className="text-xs text-slate-600 italic">
            Aucun dossier sélectionné
          </span>
        )}
      </div>

      {/* ── Drag spacer: fills remaining width, inherits titlebar-drag ── */}
      <div className="flex-1" />
    </header>
  );
}
