"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

function run(command, options = {}) {
  return execSync(command, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function info(message) {
  console.log(`[auto-pull] ${message}`);
}

function warn(message) {
  console.warn(`[auto-pull] ${message}`);
}

function main() {
  if (process.env.AUTO_PULL_DISABLE === "1") {
    info("Disabled by AUTO_PULL_DISABLE=1. Continuing without pull.");
    return;
  }

  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    info("No .git folder found. Continuing without pull.");
    return;
  }

  try {
    run("git rev-parse --is-inside-work-tree");
  } catch {
    info("Not inside a git repository. Continuing without pull.");
    return;
  }

  try {
    const pendingChanges = run("git status --porcelain");
    if (pendingChanges) {
      warn(
        "Working tree has local changes. Skipping git pull to avoid conflicts.",
      );
      return;
    }

    try {
      run("git rev-parse --abbrev-ref --symbolic-full-name @{u}");
    } catch {
      warn("No upstream branch configured. Skipping git pull.");
      return;
    }

    info("Fetching latest changes...");
    execSync("git fetch --prune", { cwd: repoRoot, stdio: "inherit" });

    info("Pulling latest version...");
    execSync("git pull --ff-only", { cwd: repoRoot, stdio: "inherit" });

    info("Repository is up to date.");
  } catch (error) {
    warn(`Auto-pull failed (${error.message}). Continuing launch.`);
  }
}

main();
