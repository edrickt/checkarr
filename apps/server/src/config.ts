import path from "node:path";
import fs from "node:fs";

// apps/server/src -> repo root (works for src via tsx and dist via node)
export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

export const DATA_DIR = process.env.CHECKARR_DATA_DIR ?? path.join(REPO_ROOT, "data");
export const DB_PATH = path.join(DATA_DIR, "checkarr.db");
export const WEB_DIST = process.env.CHECKARR_WEB_DIST ?? path.join(REPO_ROOT, "apps", "web", "dist");
export const PORT = Number(process.env.CHECKARR_PORT ?? process.env.PORT ?? 5656);
export const HOST = process.env.HOST ?? "127.0.0.1";

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
