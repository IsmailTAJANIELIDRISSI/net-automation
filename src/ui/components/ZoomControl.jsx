import React, { useState, useEffect } from "react";

/**
 * App zoom control: [−] [80%] [+] (click the percentage to reset).
 * Also owns the Ctrl + mouse-wheel gesture. Everything goes through the main
 * process (window.api.stepZoom), which persists the level and pushes it back via
 * onZoomChanged — so Ctrl +/-/0, the buttons and the wheel always agree.
 */
export default function ZoomControl() {
  const [zoom, setZoom] = useState(null);

  useEffect(() => {
    let alive = true;
    window.api
      ?.getZoom?.()
      .then((z) => alive && setZoom(z))
      .catch(() => {});
    const unsub = window.api?.onZoomChanged?.((z) => setZoom(z));
    return () => {
      alive = false;
      unsub?.();
    };
  }, []);

  // Ctrl + wheel: up = zoom in, down = zoom out. preventDefault stops Chromium's
  // own page-zoom (which would fight ours); throttled because trackpads/wheels
  // fire a burst of events per notch.
  useEffect(() => {
    let last = 0;
    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const now = Date.now();
      if (now - last < 120) return;
      last = now;
      window.api?.stepZoom?.(e.deltaY < 0 ? "in" : "out");
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  if (zoom == null) return null;
  const btn =
    "w-7 h-7 flex items-center justify-center rounded-lg bg-slate-800 hover:bg-slate-700 " +
    "text-slate-300 hover:text-white border border-slate-700 text-base font-semibold " +
    "leading-none select-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
  return (
    <div
      className="flex items-center gap-1 px-3"
      title="Zoom de l'application (Ctrl + molette)"
    >
      <button
        className={btn}
        onClick={() => window.api.stepZoom("out")}
        disabled={zoom <= 0.5}
        title="Dézoomer (Ctrl −)"
      >
        −
      </button>
      <button
        className="min-w-[46px] h-7 px-1.5 rounded-lg text-xs font-medium tabular-nums text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
        onClick={() => window.api.stepZoom("reset")}
        title="Réinitialiser le zoom (Ctrl 0)"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        className={btn}
        onClick={() => window.api.stepZoom("in")}
        disabled={zoom >= 1.5}
        title="Zoomer (Ctrl +)"
      >
        +
      </button>
    </div>
  );
}
