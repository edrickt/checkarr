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
  /** Absolute directories Checkarr may read media from (after path mappings).
   *  Empty = no confinement: installations upgraded from 1.1.x keep reading
   *  whatever the *arr reports until the operator lists their media roots. */
  mediaRoots: string[];
  /** Bind 0.0.0.0 so other devices on the LAN can open the UI (needs restart). */
  localBroadcast: boolean;
}

interface SettingsRow {
  concurrency: number;
  ffmpeg_path: string | null;
  ffprobe_path: string | null;
  path_mappings: string;
  media_roots: string;
  local_broadcast: number;
}

export function getSettings(db: DB): AppSettings {
  const row = db
    .prepare(
      "SELECT concurrency, ffmpeg_path, ffprobe_path, path_mappings, media_roots, local_broadcast FROM settings WHERE id = 1"
    )
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
    pathMappings: mappings,
    mediaRoots: parseMediaRoots(row.media_roots),
    localBroadcast: Number(row.local_broadcast) === 1
  };
}

function parseMediaRoots(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((r): r is string => typeof r === "string" && r.length > 0)
      : [];
  } catch {
    return [];
  }
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
    pathMappings: patch.pathMappings ?? current.pathMappings,
    mediaRoots: patch.mediaRoots ?? current.mediaRoots,
    localBroadcast: patch.localBroadcast ?? current.localBroadcast
  };
  db.prepare(
    "UPDATE settings SET concurrency = ?, ffmpeg_path = ?, ffprobe_path = ?, path_mappings = ?," +
      " media_roots = ?, local_broadcast = ?, updated_at = datetime('now') WHERE id = 1"
  ).run(
    next.concurrency,
    next.ffmpegPath,
    next.ffprobePath,
    JSON.stringify(next.pathMappings),
    JSON.stringify(next.mediaRoots),
    next.localBroadcast ? 1 : 0
  );
  return next;
}
