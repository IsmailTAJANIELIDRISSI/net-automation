import React, { useEffect, useRef } from 'react';

const LEVEL_COLORS = {
  info:  'text-slate-300',
  warn:  'text-amber-400',
  error: 'text-red-400',
  debug: 'text-slate-500',
  success: 'text-emerald-400',
};

const LEVEL_BADGE = {
  info:  'text-blue-400',
  warn:  'text-amber-400',
  error: 'text-red-400',
  debug: 'text-slate-500',
  success: 'text-emerald-400',
};

/**
 * Scrollable real-time log panel.
 * @param {{ logs: Array<{level, context, message, ts}>, onClear: () => void }} props
 */
export default function LogPanel({ logs, onClear }) {
  const bottomRef   = useRef(null);
  const containerRef = useRef(null);

  // Auto-scroll on new log entries
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs.length]);

  const formatTime = (ts) => {
    try {
      return new Date(ts).toLocaleTimeString('fr-FR', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch { return ts; }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-slate-900/80 rounded-xl
                    border border-slate-700/50 overflow-hidden">

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-700/50
                      bg-slate-900 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-xs font-semibold text-slate-300 tracking-wide uppercase">
            Journal d'exécution
          </span>
          <span className="text-xs text-slate-600 ml-1">({logs.length})</span>
        </div>
        <button
          onClick={onClear}
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors px-2 py-1
                     rounded hover:bg-slate-800">
          Effacer
        </button>
      </div>

      {/* ── Log entries ──────────────────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto font-mono text-xs px-3 py-3 space-y-0.5">

        {logs.length === 0 && (
          <p className="text-slate-600 text-center mt-8">
            Aucun journal — lancez une automatisation pour voir les logs ici.
          </p>
        )}

        {logs.map((entry, i) => {
          const msgColor  = LEVEL_COLORS[entry.level]  ?? 'text-slate-300';
          const lvlColor  = LEVEL_BADGE[entry.level]   ?? 'text-slate-400';

          return (
            <div key={i} className="flex gap-2 leading-relaxed group hover:bg-slate-800/50 px-1 -mx-1 rounded">
              {/* Timestamp */}
              <span className="text-slate-600 flex-shrink-0 w-20 text-right">
                {formatTime(entry.ts)}
              </span>
              {/* Level */}
              <span className={`flex-shrink-0 w-10 uppercase font-bold ${lvlColor}`}>
                {entry.level?.substring(0, 4)}
              </span>
              {/* Context */}
              <span className="text-slate-500 flex-shrink-0 w-24 truncate">
                [{entry.context}]
              </span>
              {/* Message */}
              <span className={`flex-1 ${msgColor} whitespace-pre-wrap break-all`}>
                {entry.message}
              </span>
            </div>
          );
        })}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
