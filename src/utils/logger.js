"use strict";
const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const config = require("../config/config");

// Ensure logs directory exists
const logsDir = path.resolve(config.logsDir);
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || "info"];

/**
 * logEmitter – Electron main process subscribes to this to forward
 * log entries to the renderer via webContents.send('log', entry).
 */
const logEmitter = new EventEmitter();

function timestamp() {
  return new Date().toISOString();
}

function formatLine(level, context, message) {
  return `[${timestamp()}] [${level.toUpperCase().padEnd(5)}] [${context}] ${message}`;
}

function writeToFile(line) {
  const date = new Date().toISOString().slice(0, 10);
  const logFile = path.join(logsDir, `automation-${date}.log`);
  fs.appendFileSync(logFile, line + "\n", "utf8");
}

function write(level, context, message, extra) {
  if (LOG_LEVELS[level] < CURRENT_LEVEL) return;
  const extraStr = extra ? ` | ${JSON.stringify(extra)}` : "";
  const line = formatLine(level, context, message) + extraStr;
  console.log(line);
  writeToFile(line);
  // Emit for Electron IPC forwarding
  logEmitter.emit("log", {
    level,
    context,
    message: message + (extraStr || ""),
    ts: new Date().toISOString(),
  });
}

/**
 * Create a scoped logger for a module.
 * @param {string} context - e.g. 'BADRConnection', 'PortnetDsCombine'
 */
function createLogger(context) {
  return {
    debug: (msg, extra) => write("debug", context, msg, extra),
    info: (msg, extra) => write("info", context, msg, extra),
    warn: (msg, extra) => write("warn", context, msg, extra),
    error: (msg, extra) => write("error", context, msg, extra),
  };
}

module.exports = { createLogger, logEmitter, write };
