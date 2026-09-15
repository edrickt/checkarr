#!/usr/bin/env node
// Stop the Checkarr server: pid file first, then anything left on the port.
// Works on macOS, Linux, and Windows (no WSL needed).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopTray } from "./lib/tray.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.CHECKARR_PORT ?? process.env.PORT ?? 5656);
const pidFile = path.join(root, "data", "checkarr.pid");
const isWin = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let stopped = 0;

const pid = (() => {
  try {
    return Number(fs.readFileSync(pidFile, "utf8").trim());
  } catch {
    return null;
  }
})();
function commandOf(p) {
  try {
    if (isWin) {
      // wmic is gone on current Windows; ask CIM for the command line.
      return execSync(
        "powershell -NoProfile -Command \"(Get-CimInstance Win32_Process -Filter 'ProcessId=" +
          p +
          "').CommandLine\"",
        { encoding: "utf8", windowsHide: true }
      ).trim();
    }
    return execSync("ps -p " + p + " -o command=", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

if (pid && alive(pid)) {
  const cmd = commandOf(pid);
  if (cmd !== "" && !/checkarr|apps[\\/]server/.test(cmd)) {
    console.log("pid " + pid + " is not checkarr (" + cmd.slice(0, 80) + ") - refusing to kill it");
  } else {
    console.log("stopping pid " + pid);
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
    stopped = 1;
  }
} else if (pid) {
  console.log("stale pid file (pid " + pid + " not running)");
}
try {
  fs.unlinkSync(pidFile);
} catch {}

try {
  let pids = [];
  if (isWin) {
    const out = execSync("netstat -ano -p tcp", { encoding: "utf8" });
    for (const line of out.split("\r?\n")) {
      if (line.toUpperCase().includes("LISTENING") && line.includes(":" + port + " ")) {
        const p = Number(line.trim().split(/\s+/).pop());
        if (Number.isInteger(p) && p > 0) pids.push(p);
      }
    }
  } else {
    // LISTEN only: established client sockets must not be killed.
    const out = execSync("lsof -ti tcp:" + port + " -sTCP:LISTEN 2>/dev/null || true", { encoding: "utf8" });
    pids = out
      .split("\n")
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  }
  const ours = pids.filter((p) => {
    const cmd = commandOf(p);
    if (cmd === "") return true;
    if (!/checkarr|apps[\\/]server/.test(cmd)) {
      console.log(
        "port " +
          port +
          " is held by pid " +
          p +
          " (" +
          cmd.slice(0, 80) +
          ") - not checkarr, leaving it alone"
      );
      return false;
    }
    return true;
  });
  if (ours.length > 0) {
    console.log("killing process(es) on port " + port + ": " + ours.join(" "));
    for (const p of ours) {
      try {
        process.kill(p, "SIGKILL");
      } catch {}
    }
    await sleep(1000);
    stopped = 1;
  }
} catch {}

// The tray icon is part of "running", so it goes too (CHECKARR_NO_TRAY=1
// keeps it around for a permanent menu-bar presence).
if (process.env.CHECKARR_NO_TRAY !== "1") {
  try {
    const tray = await stopTray({ root });
    if (tray.stopped) console.log("stopped tray icon (pid " + tray.pid + ")");
  } catch (err) {
    console.log("warning: could not stop the tray icon (" + (err instanceof Error ? err.message : err) + ")");
  }
}

console.log(stopped ? "stopped" : "nothing running on port " + port);
