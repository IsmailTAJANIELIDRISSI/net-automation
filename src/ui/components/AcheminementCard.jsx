import React from "react";
import StatusBadge from "./StatusBadge.jsx";

/**
 * Card representing one acheminement folder.
 * Shows PDF filenames, extracted ref, user inputs, and a Run button.
 */
export default function AcheminementCard({
  ach,
  status = "idle",
  isGlobalRunning,
  onChange,
  onRun,
}) {
  const { id, name, folderPath, manifeste, mawb, refNumber } = ach;

  const field = (key, label, placeholder = "", type = "text") => (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-slate-400 font-medium">{label}</label>
      <input
        type={type}
        value={ach[key] ?? ""}
        placeholder={placeholder}
        disabled={isGlobalRunning}
        onChange={(e) => onChange(id, key, e.target.value)}
        className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-sm
                   text-slate-100 placeholder-slate-600
                   focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50
                   disabled:opacity-50 disabled:cursor-not-allowed
                   transition-colors"
      />
    </div>
  );

  const openFile = (filename) => {
    if (filename) window.api.openPath(`${folderPath}\\${filename}`);
  };

  const isDone = status === "done";
  const isRunning = [
    "running",
    "captcha-waiting",
    "filling-form",
    "submitting-portnet",
    "portnet-submitted",
    "monitoring-portnet",
    "portnet-accepted",
    "badr-downloading",
  ].includes(status);
  const isError = status === "error" || status === "weight-mismatch";

  const cardBorder = isDone
    ? "border-emerald-700/50"
    : isError
      ? "border-red-700/50"
      : isRunning
        ? "border-blue-600/50"
        : "border-slate-700/50";

  return (
    <div
      className={`bg-slate-800/70 border ${cardBorder} rounded-xl p-4 flex flex-col gap-3
                     transition-all duration-300 shadow-lg`}
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p
            className="text-sm font-semibold text-slate-100 truncate"
            title={name}
          >
            {name}
          </p>
          {refNumber && (
            <p className="text-xs text-emerald-400 font-mono mt-0.5">
              Réf: {refNumber}
            </p>
          )}
        </div>
        <StatusBadge status={status} />
      </div>

      {/* ── PDFs ───────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2">
        {[
          { file: manifeste, label: "Manifeste", color: "text-sky-400" },
          { file: mawb, label: "MAWB / LTA", color: "text-violet-400" },
        ].map(({ file, label, color }) => (
          <button
            key={label}
            onClick={() => openFile(file)}
            disabled={!file}
            title={file || `${label} introuvable`}
            className={`flex flex-col items-start bg-slate-900/60 border border-slate-700/40
                        rounded-lg px-3 py-2 text-left disabled:opacity-40
                        hover:border-slate-600 hover:bg-slate-900 transition-colors group`}
          >
            <span className={`text-xs font-medium ${color} mb-0.5`}>
              {label}
            </span>
            <span className="text-xs text-slate-400 truncate w-full group-hover:text-slate-300">
              {file ?? "—"}
            </span>
          </button>
        ))}
      </div>

      {/* ── Ref mismatch warning ────────────────────────────────────────── */}
      {ach.refMismatch && (
        <div className="flex items-center gap-2 bg-red-900/40 border border-red-700/60 rounded-lg px-3 py-2">
          <span className="text-red-400 text-xs font-semibold">
            ⚠️ Incohérence de référence (noms de fichiers et/ou texte du
            manifeste PDF) — corrigez avant de lancer
          </span>
        </div>
      )}

      {ach.manifestPdfExtract?.ok && (
        <p className="text-[11px] text-slate-500 leading-snug">
          Données lues depuis le manifeste PDF : en-tête (MAWB / Pcs / kg /
          devise ou colonne devise), et dernière ligne du tableau (2ᵉ des trois
          totaux = valeur totale).
        </p>
      )}

      {/* ── Form fields ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2">
        {field("scelle1", "Scellé #1", "ex: SN123456")}
        {field("scelle2", "Scellé #2", "ex: SN789012")}
        {field("nombreContenant", "Nb. contenant", "ex: 3", "number")}
        {field("poidTotal", "Poids total (kg)", "ex: 245.50", "number")}
        {field("sequenceNumber", "Séquence (optionnel)", "ex: 3447 U")}
        {field(
          "lieuChargement",
          "Lieu de chargement (optionnel)",
          "ex: ABU DHABI INTERNATIONAL",
        )}

        {/* Currency + Value inline */}
        <div className="flex flex-col gap-1 col-span-2">
          <label className="text-xs text-slate-400 font-medium">
            Valeur totale
          </label>
          <div className="flex gap-2">
            <select
              value={ach.currency ?? "MAD"}
              disabled={isGlobalRunning}
              onChange={(e) => onChange(id, "currency", e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-sm
                         text-slate-100 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors w-24"
            >
              <option value="MAD">MAD</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
            </select>
            <input
              type="number"
              value={ach.totalValue ?? ""}
              placeholder="ex: 15000.00"
              disabled={isGlobalRunning}
              onChange={(e) => onChange(id, "totalValue", e.target.value)}
              className="flex-1 bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-sm
                         text-slate-100 placeholder-slate-600
                         focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            />
          </div>
        </div>
      </div>

      {/* ── Partiel LTA checkbox ──────────────────────────────────────────── */}
      <label className="flex items-center gap-2 cursor-pointer select-none mt-1">
        <input
          type="checkbox"
          checked={ach.partiel ?? false}
          disabled={isGlobalRunning}
          onChange={(e) => onChange(id, "partiel", e.target.checked)}
          className="w-4 h-4 rounded border-slate-600 bg-slate-900
                     text-yellow-500 focus:ring-yellow-500/50
                     disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <span className="text-xs text-slate-400">
          LTA Partielle
          <span className="ml-1 text-slate-600">
            (attente 2ème vol – ignorer)
          </span>
        </span>
      </label>

      {/* ── Run button ─────────────────────────────────────────────────────── */}
      <button
        onClick={() => onRun(ach)}
        disabled={isGlobalRunning || isDone || !!ach.refMismatch}
        className={`mt-1 w-full py-2 rounded-lg text-sm font-semibold transition-all duration-200
          ${
            isDone
              ? "bg-emerald-900/40 text-emerald-400 cursor-not-allowed border border-emerald-700/40"
              : isError
                ? "bg-red-600 hover:bg-red-500 text-white border border-red-500 disabled:opacity-50"
                : isRunning
                  ? "bg-blue-700/40 text-blue-300 cursor-not-allowed border border-blue-700/40 animate-pulse"
                  : "bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
          }`}
      >
        {isDone
          ? "✓ Terminé"
          : isRunning
            ? "En cours…"
            : isError
              ? "↺ Réessayer"
              : "Lancer"}
      </button>
    </div>
  );
}
