#!/usr/bin/env node
// Cross-platform (re)start: stops any running instance, builds, spawns the
// server detached, then waits until /api/stats answers. Works on macOS,
// Linux, and Windows (no WSL needed). Logs go to data/server.log, truncated
// on every start. NO_BUILD=1 skips the build step.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDesktopApp } from "./lib/desktop.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.CHECKARR_PORT ?? process.env.PORT ?? 5656);
const pidFile = path.join(root, "data", "checkarr.pid");
const logFile = path.join(root, "data", "server.log");
const isWin = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readPid = () => {
  try {
    return Number(fs.readFileSync(pidFile, "utf8").trim());
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// PIDs get reused: make sure the process is actually Checkarr before
// killing it. Returns "" when the command line cannot be determined.
function commandOf(pid) {
  try {
    if (isWin) {
      // wmic is gone on current Windows; ask CIM for the command line.
      return execSync(
        "powershell -NoProfile -Command \"(Get-CimInstance Win32_Process -Filter 'ProcessId=" +
          pid +
          "').CommandLine\"",
        { encoding: "utf8", windowsHide: true }
      ).trim();
    }
    return execSync("ps -p " + pid + " -o command=", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function looksLikeCheckarr(pid) {
  const cmd = commandOf(pid);
  if (cmd === "") return true; // cannot tell - keep old behavior
  return /checkarr|apps[\\/]server/.test(cmd);
}

async function killPrevious() {
  const pid = readPid();
  if (pid && alive(pid)) {
    if (!looksLikeCheckarr(pid)) {
      console.log(
        "pid " +
          pid +
          " is not checkarr (" +
          commandOf(pid).slice(0, 80) +
          ") - refusing to kill it; delete data/checkarr.pid if it is stale"
      );
    } else {
      console.log("stopping previous instance (pid " + pid + ")");
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      const t0 = Date.now();
      while (alive(pid) && Date.now() - t0 < 10_000) await sleep(200);
      if (alive(pid)) {
        console.log("still alive, sending SIGKILL");
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  }
  try {
    fs.unlinkSync(pidFile);
  } catch {}
}

function pidsOnPort() {
  try {
    if (isWin) {
      const out = execSync("netstat -ano -p tcp", { encoding: "utf8" });
      const pids = new Set();
      for (const line of out.split("\r?\n")) {
        if (!line.toUpperCase().includes("LISTENING")) continue;
        if (!line.includes(":" + port + " ")) continue;
        const pid = Number(line.trim().split(/\s+/).pop());
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      return [...pids];
    }
    // LISTEN only: without this, established client sockets (your browser!)
    // match and get SIGKILLed by a restart.
    const out = execSync("lsof -ti tcp:" + port + " -sTCP:LISTEN 2>/dev/null || true", { encoding: "utf8" });
    return out
      .split("\n")
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

async function killPortStrays() {
  const pids = pidsOnPort();
  if (pids.length === 0) return;
  for (const pid of pids) {
    if (!looksLikeCheckarr(pid)) {
      console.log(
        "port " +
          port +
          " is held by pid " +
          pid +
          " (" +
          commandOf(pid).slice(0, 80) +
          ") - not checkarr, leaving it alone"
      );
      continue;
    }
    console.log("killing stale checkarr on port " + port + " (pid " + pid + ")");
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await sleep(1000);
  for (const pid of pidsOnPort()) {
    if (looksLikeCheckarr(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
}

await killPrevious();
await killPortStrays();

if (process.env.NO_BUILD !== "1") {
  console.log("building...");
  const build = spawn("pnpm build", { stdio: "inherit", shell: true, cwd: root, windowsHide: true });
  const code = await new Promise((resolve) => build.on("exit", resolve));
  if (code !== 0) {
    console.error("build failed - not starting");
    process.exit(1);
  }
}

// Keep the app-drawer icon in sync with this checkout (path, node, pnpm).
// Best effort: a missing icon must never stop the server from starting.
// Opt out with CHECKARR_NO_DESKTOP_APP=1.
async function installDesktopApp() {
  if (process.env.CHECKARR_NO_DESKTOP_APP === "1") return;
  try {
    const result = await ensureDesktopApp({ root });
    console.log("desktop icon " + (result.updated ? "installed" : "ready") + ": " + result.target);
  } catch (err) {
    console.log(
      "warning: desktop icon not installed (" +
        (err instanceof Error ? err.message : err) +
        ') - retry with "pnpm app:install"'
    );
  }
}

const entry = path.join(root, "apps", "server", "dist", "index.js");
if (!fs.existsSync(entry)) {
  console.error("missing " + path.relative(root, entry) + " - run a build first (or drop NO_BUILD=1)");
  process.exit(1);
}

// fresh clone has no data/ yet (gitignored) - create it before writing the log
fs.mkdirSync(path.dirname(logFile), { recursive: true });
const out = fs.openSync(logFile, "w");
const child = spawn(process.execPath, [entry], {
  cwd: root,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", out, out]
});
child.unref();
fs.writeFileSync(pidFile, String(child.pid));
fs.closeSync(out);
console.log("started pid " + child.pid + ", logs: data/server.log");

for (let i = 0; i < 30; i++) {
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/api/stats", { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      console.log("up: http://127.0.0.1:" + port);
      await installDesktopApp();
      process.exit(0);
    }
  } catch {}
  await sleep(500);
}

console.error("server did not become ready within 15s - last log lines:");
try {
  const lines = fs.readFileSync(logFile, "utf8").trimEnd().split("\n");
  console.error(lines.slice(-20).join("\n"));
} catch {}
process.exit(1);
