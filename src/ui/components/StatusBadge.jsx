import React from "react";

/**
 * Status badge shown on each AcheminementCard.
 * @param {{ status: 'idle'|'running'|'captcha-waiting'|'filling-form'|'submitting-portnet'|'portnet-submitted'|'monitoring-portnet'|'portnet-accepted'|'badr-downloading'|'done'|'error'|'weight-mismatch' }} props
 */
export default function StatusBadge({ status }) {
  const variants = {
    idle: "bg-slate-700 text-slate-300",
    running: "bg-blue-900/60 text-blue-300 animate-pulse",
    "captcha-waiting": "bg-amber-900/60 text-amber-300 animate-pulse",
    "filling-form": "bg-indigo-900/60 text-indigo-300 animate-pulse",
    "submitting-portnet": "bg-cyan-900/60 text-cyan-300 animate-pulse",
    "portnet-submitted": "bg-sky-900/60 text-sky-300",
    "monitoring-portnet": "bg-blue-900/60 text-blue-300 animate-pulse",
    "portnet-accepted": "bg-teal-900/60 text-teal-300",
    "badr-downloading": "bg-violet-900/60 text-violet-300 animate-pulse",
    done: "bg-emerald-900/60 text-emerald-300",
    error: "bg-red-900/60 text-red-300",
    "weight-mismatch": "bg-orange-900/60 text-orange-300",
    "partiel-skip": "bg-yellow-900/60 text-yellow-300",
  };

  const labels = {
    idle: "En attente",
    running: "En cours…",
    "captcha-waiting": "Attente CAPTCHA",
    "filling-form": "Remplissage…",
    "submitting-portnet": "Soumission Portnet",
    "portnet-submitted": "Déjà envoyé",
    "monitoring-portnet": "Suivi Portnet",
    "portnet-accepted": "Acceptée",
    "badr-downloading": "Finalisation BADR",
    done: "Terminé",
    error: "Erreur",
    "weight-mismatch": "Écart poids",
    "partiel-skip": "LTA Partielle",
  };

  const cls = variants[status] ?? variants.idle;
  const label = labels[status] ?? status;

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls}`}
    >
      {status !== "idle" && status !== "done" && status !== "error" && (
        <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current" />
      )}
      {label}
    </span>
  );
}
