import type { DB } from "./db.js";

export interface PathMapping {
  /** Prefix to match against the path reported by Radarr/Sonarr. */
  match: string;
  /** Replacement prefix used on the Checkarr host. */
  replace: string;
}

export interface AppSettings {
  concurrency: number;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  pathMappings: PathMapping[];
}

interface SettingsRow {
  concurrency: number;
  ffmpeg_path: string | null;
  ffprobe_path: string | null;
  path_mappings: string;
}

export function getSettings(db: DB): AppSettings {
  const row = db
    .prepare("SELECT concurrency, ffmpeg_path, ffprobe_path, path_mappings FROM settings WHERE id = 1")
    .get() as unknown as SettingsRow;
  let mappings: PathMapping[] = [];
  try {
    const parsed = JSON.parse(row.path_mappings);
    if (Array.isArray(parsed)) mappings = parsed.filter(isMapping);
  } catch {
    // fall through with empty mappings
  }
  return {
    concurrency: Number(row.concurrency) || 8,
    ffmpegPath: row.ffmpeg_path || null,
    ffprobePath: row.ffprobe_path || null,
    pathMappings: mappings
  };
}

function isMapping(v: unknown): v is PathMapping {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return typeof m.match === "string" && m.match.length > 0 && typeof m.replace === "string";
}

export function saveSettings(db: DB, patch: Partial<AppSettings>): AppSettings {
  const current = getSettings(db);
  const next: AppSettings = {
    concurrency: patch.concurrency ?? current.concurrency,
    ffmpegPath: patch.ffmpegPath !== undefined ? patch.ffmpegPath : current.ffmpegPath,
    ffprobePath: patch.ffprobePath !== undefined ? patch.ffprobePath : current.ffprobePath,
    pathMappings: patch.pathMappings ?? current.pathMappings
  };
  db.prepare(
    "UPDATE settings SET concurrency = ?, ffmpeg_path = ?, ffprobe_path = ?, path_mappings = ?," +
      " updated_at = datetime('now') WHERE id = 1"
  ).run(next.concurrency, next.ffmpegPath, next.ffprobePath, JSON.stringify(next.pathMappings));
  return next;
}
