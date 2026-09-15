// Support for the desktop launcher (scripts/launch.mjs): decide whether the
// build output is stale, tell a Checkarr server apart from whatever else may
// hold the port, and open the dashboard in the user's browser.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Everything a build reads from, relative to the repo root. Dependency
// changes land in pnpm-lock.yaml, so its mtime stands in for node_modules.
const BUILD_INPUTS = [
  ["apps", "server", "src"],
  ["apps", "web", "src"],
  ["apps", "server", "package.json"],
  ["apps", "server", "tsconfig.json"],
  ["apps", "web", "package.json"],
  ["apps", "web", "index.html"],
  ["apps", "web", "vite.config.ts"],
  ["apps", "web", "tsconfig.json"],
  ["package.json"],
  ["pnpm-lock.yaml"],
  ["pnpm-workspace.yaml"],
  ["tsconfig.base.json"]
];

// Both must exist and be at least as new as the sources above.
const BUILD_OUTPUTS = [
  ["apps", "server", "dist", "index.js"],
  ["apps", "web", "dist", "index.html"]
];

function newestMtime(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  // Only file mtimes count: a directory's own mtime moves whenever anything
  // inside is created or removed, which is not a source change.
  let newest = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    newest = Math.max(newest, newestMtime(path.join(target, entry.name)));
  }
  return newest;
}

/** True when the built server/UI is missing or older than what it was built from. */
export function needsBuild(root) {
  const outputs = BUILD_OUTPUTS.map((parts) => path.join(root, ...parts));
  if (outputs.some((file) => !fs.existsSync(file))) return true;
  const outputTime = Math.min(...outputs.map((file) => fs.statSync(file).mtimeMs));
  let sourceTime = 0;
  for (const parts of BUILD_INPUTS) {
    const target = path.join(root, ...parts);
    if (!fs.existsSync(target)) continue;
    sourceTime = Math.max(sourceTime, newestMtime(target));
  }
  return sourceTime > outputTime;
}

/** The /api/stats shape from apps/server/src/routes.ts. */
export function isCheckarrStats(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.total === "number" &&
    value.byStatus !== null &&
    typeof value.byStatus === "object" &&
    typeof value.byStatus.healthy === "number"
  );
}

export const statsUrl = (port) => `http://127.0.0.1:${port}/api/stats`;

/** One health probe: does this URL answer with Checkarr's stats? */
export async function probeCheckarr(url, options = {}) {
  const { fetchImpl = fetch, timeoutMs = 1500 } = options;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    return isCheckarrStats(await res.json());
  } catch {
    return false;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until Checkarr answers, or until the deadline passes. */
export async function waitForServer(url, options = {}) {
  const {
    timeoutMs = 30_000,
    intervalMs = 500,
    now = Date.now,
    sleep = defaultSleep,
    fetchImpl = fetch
  } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await probeCheckarr(url, { fetchImpl, timeoutMs: Math.min(1500, timeoutMs) })) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

export function browserCommand(platform, url) {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "linux") return { cmd: "xdg-open", args: [url] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  throw new Error(`unsupported platform for opening a browser: ${platform}`);
}

export function openBrowser(url, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawnImpl ?? spawn;
  const { cmd, args } = browserCommand(platform, url);
  const child = spawnImpl(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
