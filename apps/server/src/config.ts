import path from "node:path";
import fs from "node:fs";

// apps/server/src -> repo root (works for src via tsx and dist via node)
export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

export const DATA_DIR = process.env.CHECKARR_DATA_DIR ?? path.join(REPO_ROOT, "data");
export const DB_PATH = path.join(DATA_DIR, "checkarr.db");
export const WEB_DIST = process.env.CHECKARR_WEB_DIST ?? path.join(REPO_ROOT, "apps", "web", "dist");
export const PORT = Number(process.env.CHECKARR_PORT ?? process.env.PORT ?? 5656);
// An explicit HOST in the environment (e.g. Docker) always wins over the
// settings toggle; without it, "local broadcast" binds every interface.
export const ENV_HOST = process.env.HOST ?? null;

let bindHost = ENV_HOST ?? "127.0.0.1";

export function getBindHost(): string {
  return bindHost;
}

/** Resolve (and remember) the bind host for a local-broadcast setting. */
export function applyLocalBroadcastSetting(localBroadcast: boolean): string {
  bindHost = ENV_HOST ?? (localBroadcast ? "0.0.0.0" : "127.0.0.1");
  return bindHost;
}

export function isBroadcastHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
