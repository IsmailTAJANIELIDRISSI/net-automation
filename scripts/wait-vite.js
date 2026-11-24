"use strict";
/**
 * Waits for the Vite dev server then launches Electron.
 * Reads VITE_PORT from .env or environment (default 5173, same as vite.config.js).
 */
require("dotenv").config();
const { execSync } = require("child_process");
const port = process.env.VITE_PORT || "5173";
execSync(
  `wait-on http://localhost:${port} && cross-env NODE_ENV=development electron .`,
  { stdio: "inherit", shell: true },
);
