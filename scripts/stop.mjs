#!/usr/bin/env node
// Stop the Checkarr server: pid file first, then anything left on the port.
// Works on macOS, Linux, and Windows (no WSL needed).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
if (pid && alive(pid)) {
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
    const out = execSync("lsof -ti tcp:" + port + " 2>/dev/null || true", { encoding: "utf8" });
    pids = out.split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  }
  if (pids.length > 0) {
    console.log("killing process(es) on port " + port + ": " + pids.join(" "));
    for (const p of pids) {
      try {
        process.kill(p, "SIGKILL");
      } catch {}
    }
    await sleep(1000);
    stopped = 1;
  }
} catch {}

console.log(stopped ? "stopped" : "nothing running on port " + port);
