"use strict";
/**
 * Electron Preload Script
 * Exposes a safe, typed API to the React renderer via contextBridge.
 * Nothing from Node.js / Electron is directly accessible in the renderer.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // ── Folder management ──────────────────────────────────────────────────────
  selectFolder: () => ipcRenderer.invoke("dialog:openFolder"),

  scanFolder: (folderPath) => ipcRenderer.invoke("folder:scan", folderPath),

  openPath: (filePath) => ipcRenderer.invoke("shell:openPath", filePath),

  // ── Automation ─────────────────────────────────────────────────────────────
  runAutomation: (acheminement) =>
    ipcRenderer.invoke("automation:run", acheminement),

  runAllAutomation: (acheminements) =>
    ipcRenderer.invoke("automation:run-all", acheminements),

  // ── Persist form data ──────────────────────────────────────────────────────
  saveAcheminement: (folderPath, data) =>
    ipcRenderer.invoke("acheminement:save", { folderPath, data }),

  // ── Live event subscriptions ───────────────────────────────────────────────
  /** @param {(entry: {level:string, context:string, message:string, ts:string}) => void} cb */
  onLog: (cb) => {
    const listener = (_event, entry) => cb(entry);
    ipcRenderer.on("log", listener);
    // Return cleanup function
    return () => ipcRenderer.removeListener("log", listener);
  },

  /** @param {(p: {acheminementId:string, status:string, [key:string]: any}) => void} cb */
  onProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on("progress", listener);
    return () => ipcRenderer.removeListener("progress", listener);
  },

  // ── Utilities ──────────────────────────────────────────────────────────────
  platform: process.platform,
});
