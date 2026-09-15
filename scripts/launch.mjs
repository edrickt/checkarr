#!/usr/bin/env node
// Entry point for the desktop icon (Checkarr.app on macOS). Double-clicking
// the icon runs this: if the server is already up, it just opens the
// dashboard; otherwise it starts the server (building only when the build
// output is stale), waits for it to answer, then opens the dashboard.
//
// Everything is logged to data/launcher.log, because a Finder-launched app
// has no terminal to print to.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { needsBuild, openBrowser, probeCheckarr, statsUrl, waitForServer } from "./lib/launcher.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.CHECKARR_PORT ?? process.env.PORT ?? 5656);
const url = `http://127.0.0.1:${port}`;
const dataDir = path.join(root, "data");
const logFile = path.join(dataDir, "launcher.log");
const startLog = path.join(dataDir, "server.log");
const lockFile = path.join(dataDir, "launcher.lock");
const LOCK_STALE_MS = 120_000;

function log(line) {
  const stamp = new Date().toISOString();
  for (const text of String(line).split("\n")) {
    try {
      fs.appendFileSync(logFile, `${stamp} ${text}\n`);
    } catch {}
  }
}

function logTail(file, lines) {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function showAlert(title, message) {
  const clean = String(message).replace(/\s+/g, " ").slice(0, 400);
  try {
    if (process.platform === "darwin") {
      const escaped = clean.replace(/["\\]/g, " ");
      execFileSync("osascript", ["-e", `display alert "${title}" message "${escaped}" as critical`], {
        stdio: "ignore"
      });
    } else if (process.platform === "linux") {
      execFileSync("zenity", ["--error", "--title", title, "--text", clean], { stdio: "ignore" });
    } else if (process.platform === "win32") {
      const ps = clean.replace(/'/g, "''");
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${ps}','${title}',0,16)`
        ],
        { stdio: "ignore", windowsHide: true }
      );
    }
  } catch {}
}

/** Serialize concurrent launches (an impatient double-double-click). */
function acquireLock() {
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    try {
      if (Date.now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lockFile, { force: true });
        return acquireLock();
      }
    } catch {}
    return false;
  }
}

function releaseLock() {
  try {
    if (fs.readFileSync(lockFile, "utf8") === String(process.pid)) fs.rmSync(lockFile, { force: true });
  } catch {}
}

/** Run scripts/start.mjs with its output appended to the launcher log. */
function runStart(build) {
  const out = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [path.join(root, "scripts", "start.mjs")], {
    cwd: root,
    // start.mjs must not open a second dashboard tab: this process opens it
    // once the server answers (below), which is what a click means.
    env: { ...process.env, ...(build ? {} : { NO_BUILD: "1" }), CHECKARR_NO_OPEN: "1" },
    stdio: ["ignore", out, out],
    windowsHide: true
  });
  return new Promise((resolve) => {
    child.on("error", (err) => {
      log(`failed to run start.mjs: ${err.message}`);
      resolve(-1);
    });
    child.on("exit", (code) => resolve(code ?? -1));
  }).finally(() => fs.closeSync(out));
}

async function main() {
  log(`--- launch requested: ${url}`);
  if (await probeCheckarr(statsUrl(port))) {
    log("server already running - opening the dashboard");
    openBrowser(url);
    return 0;
  }

  if (acquireLock()) {
    try {
      const build = needsBuild(root);
      log(build ? "build output is missing or stale - building" : "build output is fresh");
      const code = await runStart(build);
      if (code !== 0) log(`start.mjs exited with code ${code}`);
    } finally {
      releaseLock();
    }
  } else {
    log("another launch is already starting the server - waiting");
  }

  if (await waitForServer(statsUrl(port), { timeoutMs: 60_000 })) {
    log("server is up - opening the dashboard");
    openBrowser(url);
    return 0;
  }

  log(`server did not answer on ${url}; last server log:\n${logTail(startLog, 20)}`);
  showAlert(
    "Checkarr could not start",
    `Nothing answered on ${url}. Check data/server.log and data/launcher.log for details.`
  );
  return 1;
}

process.exit(await main());
