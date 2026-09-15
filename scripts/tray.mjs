#!/usr/bin/env node
// Start, stop, or report the tray icon for this checkout. `pnpm start` and
// `pnpm stop` already call this - the commands are for poking at it by hand:
//   node scripts/tray.mjs [start|stop|status]
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCommandOf, ensureTray, readTrayPid, stopTray, trayPaths } from "./lib/tray.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] ?? "start";
const pretty = (target) => target?.replace(os.homedir(), "~") ?? "nothing";

try {
  if (command === "start") {
    const result = await ensureTray({ root });
    if (result.started) console.log(`tray icon ready: ${pretty(result.target)}`);
    else console.log(`tray icon not started: ${result.reason ?? "already running"}`);
  } else if (command === "stop") {
    const result = await stopTray({ root });
    console.log(result.stopped ? `stopped tray icon (pid ${result.pid})` : "no Checkarr tray icon running");
  } else if (command === "status") {
    const paths = trayPaths({ root });
    const pid = readTrayPid(paths);
    if (pid) console.log(`tray icon pid ${pid} (${defaultCommandOf(pid) || "command unknown"})`);
    else console.log("no tray icon running");
  } else {
    console.error("usage: node scripts/tray.mjs [start|stop|status]");
    process.exit(2);
  }
} catch (err) {
  console.error(`tray icon ${command} failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
