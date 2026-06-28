import React, { useState } from "react";
import StatusBadge from "./StatusBadge.jsx";
import { getMissingRequiredFields } from "../requiredFields.js";

/**
 * Card representing one acheminement folder.
 * Shows PDF filenames, extracted ref, user inputs, and a Run button.
 */
export default function AcheminementCard({
  ach,
  status = "idle",
  error,
  isGlobalRunning,
  shipperLoading = false,
  onChange,
  onRun,
  onDelete,
  onDeclareScelles,
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
  const isWaitingSignature = status === "partiel-waiting-signature";

  // Obligatory fields (scellés, nb contenant, poids total, valeur totale).
  // The LTA cannot be launched until they are all filled.
  const missingRequired = getMissingRequiredFields(ach);
  const hasMissingRequired = missingRequired.length > 0;

  // Local state for the signed-serie input (prefilled with the validated serie)
  const [signedSerie, setSignedSerie] = useState(
    ach.automationState?.dumSerie ?? "",
  );

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

      {/* ── Manifest ↔ MAWB pieces/weight mismatch (partiel) ──────────────── */}
      {ach.mawbMismatch && (
        <div className="flex items-start gap-2 bg-red-900/40 border border-red-700/60 rounded-lg px-3 py-2">
          <span className="text-red-400 text-xs font-semibold leading-snug">
            ⚠️ {ach.mawbMismatch}
          </span>
        </div>
      )}

      {/* ── Uncertain MAWB freight (partiel) — must be typed manually ──────── */}
      {ach.partiel && ach.fretUncertain && !String(ach.fretValue ?? "").trim() && (
        <div className="flex items-start gap-2 bg-amber-900/30 border border-amber-700/50 rounded-lg px-3 py-2">
          <span className="text-amber-300 text-xs font-semibold leading-snug">
            ⚠️ Valeur fret MAWB non vérifiée (Total Prepaid mal placé ou illisible
            sur le MAWB) — vérifiez le document et saisissez-la manuellement
            ci-dessous avant de lancer.
          </span>
        </div>
      )}

      {/* ── Ref mismatch warning ────────────────────────────────────────── */}
      {ach.refMismatch && (
        <div className="flex flex-col gap-2 bg-red-900/40 border border-red-700/60 rounded-lg px-3 py-2">
          <span className="text-red-400 text-xs font-semibold">
            ⚠️ Incohérence de référence (noms de fichiers et/ou texte du
            manifeste PDF) — corrigez la référence ci-dessous
          </span>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-400 font-medium">
              Manifest ref LTA
            </label>
            <input
              type="text"
              value={ach.manifestRef ?? ach.manifestPdfExtract?.refNumber ?? ""}
              placeholder="ex: 157-53609710"
              disabled={isGlobalRunning}
              onChange={(e) => onChange(id, "manifestRef", e.target.value)}
              className="bg-slate-900 border border-amber-600/60 rounded px-2.5 py-1.5 text-sm
                         text-slate-100 placeholder-slate-600
                         focus:border-amber-400 focus:ring-1 focus:ring-amber-400/50
                         disabled:opacity-50 disabled:cursor-not-allowed
                         transition-colors"
            />
          </div>
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
          <span className="ml-1 text-slate-600">(DUM Normale — 2 vols)</span>
        </span>
      </label>

      {/* ── Partiel extra fields ──────────────────────────────────────────── */}
      {ach.partiel && (
        <div className="grid grid-cols-2 gap-2 border border-yellow-700/40 bg-yellow-900/10 rounded-lg p-3">
          <div className="col-span-2">
            <label className="text-xs text-yellow-400 font-semibold mb-1 block">
              Champs DUM Normale Partiel
            </label>
          </div>
          {/* Expéditeur field — shows skeleton while MAWB extraction is running */}
          <div className="col-span-2">
            {shipperLoading ? (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-slate-400 font-medium">
                  Expéditeur (société)
                </label>
                <div className="relative h-9 rounded overflow-hidden bg-slate-900 border border-slate-700">
                  <div
                    className="absolute inset-0 bg-gradient-to-r from-slate-900 via-slate-700/60 to-slate-900
                                  animate-shimmer
                                  bg-[length:200%_100%]"
                  />
                  <span className="absolute inset-0 flex items-center px-3 text-xs text-slate-500 italic">
                    Extraction MAWB en cours…
                  </span>
                </div>
              </div>
            ) : (
              field(
                "shipperName",
                "Expéditeur (société)",
                "ex: SHANGHAI FIXLINK...",
              )
            )}
          </div>
          {field("fretValue", "Valeur fret MAWB", "ex: 1200.00", "number")}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-400 font-medium">
              Devise MAWB
            </label>
            <input
              type="text"
              value={ach.mawbCurrency ?? ""}
              disabled={isGlobalRunning}
              maxLength={3}
              placeholder="USD"
              onChange={(e) =>
                onChange(id, "mawbCurrency", e.target.value.toUpperCase())
              }
              className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-sm
                         text-slate-100 focus:border-yellow-500 focus:ring-1 focus:ring-yellow-500/50
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors w-24"
            />
          </div>
          {field("qteFacturee", "Quantité facturée", "ex: 1618", "number")}
        </div>
      )}

      {/* ── Run button / Terminé / Waiting signature ────────────────────── */}
      {isDone ? (
        <div className="mt-1 flex gap-1.5">
          {/* 80% — Terminé indicator */}
          <div
            className="flex-1 py-2 rounded-lg text-sm font-semibold text-center
                       bg-emerald-900/40 text-emerald-400 border border-emerald-700/40
                       cursor-not-allowed select-none"
          >
            ✓ Terminé
          </div>
          {/* 20% — delete button */}
          <button
            onClick={() => onDelete?.(ach)}
            disabled={isGlobalRunning}
            title="Supprimer ce dossier"
            className="w-[20%] py-2 rounded-lg text-sm font-semibold transition-all duration-200
                       bg-red-900/40 hover:bg-red-700/60 text-red-400 hover:text-red-200
                       border border-red-700/40 hover:border-red-600
                       disabled:opacity-50 disabled:cursor-not-allowed
                       flex items-center justify-center"
          >
            🗑
          </button>
        </div>
      ) : isWaitingSignature ? (
        /* ── Manual-signature waiting panel ──────────────────────────────── */
        <div className="mt-1 flex flex-col gap-2 bg-amber-900/20 border border-amber-700/40 rounded-lg p-3">
          <p className="text-xs text-amber-400 font-semibold">
            ✍ Signature manuelle requise dans BADR
          </p>
          {error && (
            <p className="text-xs text-red-400 bg-red-900/20 border border-red-700/40 rounded px-2 py-1">
              ⚠ {error}
            </p>
          )}
          {/* Show validated serie/cle so the user knows what to sign */}
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-slate-400">
              Référence DUM à signer :
            </span>
            <span className="text-sm font-mono text-amber-300 px-2 py-1 bg-slate-900/50 rounded select-all">
              301 — 000 — {new Date().getFullYear()} —{" "}
              {ach.automationState?.dumSerie ?? "—"} —{" "}
              {ach.automationState?.dumCle ?? "—"}
            </span>
          </div>
          {/* Input for signed serie (user fills in after signing) */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-400 font-medium">
              Série signée (après validation BADR)
            </label>
            <input
              type="text"
              value={signedSerie}
              onChange={(e) => setSignedSerie(e.target.value)}
              placeholder={ach.automationState?.dumSerie ?? "ex: 3064"}
              disabled={isGlobalRunning}
              className="bg-slate-900 border border-amber-700/50 rounded px-2.5 py-1.5 text-sm
                         text-slate-100 placeholder-slate-600 font-mono
                         focus:border-amber-400 focus:ring-1 focus:ring-amber-400/50
                         disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            />
          </div>
          <button
            onClick={() => onDeclareScelles?.(ach, signedSerie)}
            disabled={!signedSerie.trim() || isGlobalRunning}
            className="w-full py-2 rounded-lg text-sm font-semibold transition-all duration-200
                       bg-amber-700 hover:bg-amber-600 text-white border border-amber-600
                       disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
          >
            ✍ Déclarer scellés
          </button>
        </div>
      ) : (
        <>
          {isError && error && (
            <p className="text-[11px] text-red-400 bg-red-900/20 border border-red-700/40 rounded px-2 py-1 leading-snug">
              ⚠ {error}
            </p>
          )}
          {hasMissingRequired && !isRunning && (
            <p className="text-[11px] text-amber-400 bg-amber-900/20 border border-amber-700/40 rounded px-2 py-1">
              ⚠ Champs obligatoires manquants : {missingRequired.join(", ")}
            </p>
          )}
          <button
            onClick={() => onRun(ach)}
            disabled={
              isGlobalRunning ||
              (!!ach.refMismatch && !ach.manifestRef) ||
              !!ach.mawbMismatch ||
              (hasMissingRequired && !isRunning)
            }
            title={
              ach.mawbMismatch
                ? ach.mawbMismatch
                : hasMissingRequired
                  ? `Champs obligatoires manquants : ${missingRequired.join(", ")}`
                  : undefined
            }
            className={`mt-1 w-full py-2 rounded-lg text-sm font-semibold transition-all duration-200
            ${
              isError
                ? "bg-red-600 hover:bg-red-500 text-white border border-red-500 disabled:opacity-50"
                : isRunning
                  ? "bg-blue-700/40 text-blue-300 cursor-not-allowed border border-blue-700/40 animate-pulse"
                  : "bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
            }`}
          >
            {isRunning ? "En cours…" : isError ? "↺ Réessayer" : "Lancer"}
          </button>
        </>
      )}
    </div>
  );
}
