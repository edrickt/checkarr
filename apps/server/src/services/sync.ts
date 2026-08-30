import type { DB } from "../db.js";

const NL = String.fromCharCode(10);

export interface SyncEntry {
  externalId: string;
  title: string;
  subtitle: string | null;
  path: string;
  sizeBytes: number | null;
  quality: string | null;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  total: number;
}

function trimSlashes(s: string): string {
  let out = s;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

export async function fetchArr(baseUrl: string, apiKey: string, apiPath: string): Promise<unknown> {
  const root = trimSlashes(baseUrl);
  let res: Response;
  try {
    res = await fetch(root + apiPath, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000)
    });
  } catch (err) {
    throw new Error("Cannot reach " + root + " : " + String((err as Error)?.message ?? err));
  }
  if (res.status === 401) throw new Error("Unauthorized (401) - check the API key");
  if (!res.ok) throw new Error("GET " + apiPath + " failed: HTTP " + res.status + " " + res.statusText);
  return res.json();
}

interface QualityWrapped {
  quality?: { name?: string } | null;
}

interface RadarrMovie {
  id: number;
  title: string;
  year?: number;
  movieFile?: { path?: string; size?: number; quality?: QualityWrapped } | null;
}

interface SonarrSeries {
  id: number;
  title: string;
}

interface SonarrEpisode {
  id: number;
  seriesId: number;
  seasonNumber?: number;
  episodeNumber?: number;
  title?: string;
  hasFile?: boolean;
  episodeFile?: { path?: string; size?: number; quality?: QualityWrapped } | null;
}

function qualityName(q?: QualityWrapped): string | null {
  return q?.quality?.name ?? null;
}

export async function radarrEntries(baseUrl: string, apiKey: string): Promise<SyncEntry[]> {
  const movies = (await fetchArr(baseUrl, apiKey, "/api/v3/movie")) as RadarrMovie[];
  const out: SyncEntry[] = [];
  for (const m of Array.isArray(movies) ? movies : []) {
    const f = m.movieFile;
    if (!f || typeof f.path !== "string" || f.path.length === 0) continue;
    out.push({
      externalId: String(m.id),
      title: String(m.title ?? "Untitled"),
      subtitle: typeof m.year === "number" ? String(m.year) : null,
      path: f.path,
      sizeBytes: typeof f.size === "number" ? f.size : null,
      quality: qualityName(f.quality)
    });
  }
  return out;
}

export async function sonarrEntries(baseUrl: string, apiKey: string): Promise<SyncEntry[]> {
  const series = (await fetchArr(baseUrl, apiKey, "/api/v3/series")) as SonarrSeries[];
  const out: SyncEntry[] = [];
  const pad = (n?: number): string => (typeof n === "number" ? String(n).padStart(2, "0") : "??");
  // Sonarr's /api/v3/episode requires a seriesId (bare calls get HTTP 400) and only
  // embeds episodeFile when includeEpisodeFile=true, so fetch series by series.
  for (const s of Array.isArray(series) ? series : []) {
    if (typeof s.id !== "number") continue;
    let episodes: SonarrEpisode[];
    try {
      episodes = (await fetchArr(baseUrl, apiKey, "/api/v3/episode?seriesId=" + s.id + "&includeEpisodeFile=true")) as SonarrEpisode[];
    } catch (err) {
      throw new Error("while listing episodes for '" + String(s.title ?? "series " + s.id) + "': " + String((err as Error)?.message ?? err));
    }
    for (const e of Array.isArray(episodes) ? episodes : []) {
      const f = e.episodeFile;
      if (!f || typeof f.path !== "string" || f.path.length === 0) continue;
      out.push({
        externalId: String(e.id),
        title: String(s.title ?? "Series " + s.id),
        subtitle: "S" + pad(e.seasonNumber) + "E" + pad(e.episodeNumber) + (e.title ? " " + e.title : ""),
        path: f.path,
        sizeBytes: typeof f.size === "number" ? f.size : null,
        quality: qualityName(f.quality)
      });
    }
  }
  return out;
}

export interface SourceCore {
  id: number;
  type: string;
  name: string;
  base_url: string;
  api_key: string;
}

export async function testSource(
  type: string,
  baseUrl: string,
  apiKey: string
): Promise<{ ok: boolean; appName?: string; version?: string; mismatch?: boolean; error?: string }> {
  const expected = type === "radarr" ? "Radarr" : "Sonarr";
  try {
    const status = (await fetchArr(baseUrl, apiKey, "/api/v3/system/status")) as { appName?: string; version?: string };
    const appName = status?.appName ?? undefined;
    return { ok: true, appName, version: status?.version, mismatch: appName !== undefined && appName !== expected };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

/**
 * Pull the library from one source and upsert into media_files.
 * Existing verdicts are never reset; rows whose path no longer appears are removed.
 */
export async function syncSource(db: DB, source: SourceCore): Promise<SyncResult> {
  const entries = source.type === "radarr"
    ? await radarrEntries(source.base_url, source.api_key)
    : await sonarrEntries(source.base_url, source.api_key);
  const kind = source.type === "radarr" ? "movie" : "episode";
  const now = new Date().toISOString();

  const existsStmt = db.prepare("SELECT id FROM media_files WHERE source_id = ? AND path = ?");
  const upsertStmt = db.prepare(
    "INSERT INTO media_files (source_id, kind, external_id, title, subtitle, path, size_bytes, quality)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?)" +
      " ON CONFLICT(source_id, path) DO UPDATE SET" +
      " external_id = excluded.external_id, title = excluded.title, subtitle = excluded.subtitle," +
      " size_bytes = excluded.size_bytes, quality = excluded.quality, updated_at = excluded.updated_at"
  );
  let added = 0;
  let updated = 0;

  db.exec("CREATE TEMP TABLE IF NOT EXISTS sync_paths (path TEXT PRIMARY KEY)");
  db.exec("DELETE FROM sync_paths");
  const insPath = db.prepare("INSERT OR IGNORE INTO sync_paths (path) VALUES (?)");

  db.exec("BEGIN");
  try {
    for (const e of entries) {
      const existing = existsStmt.get(source.id, e.path);
      upsertStmt.run(source.id, kind, e.externalId, e.title, e.subtitle, e.path, e.sizeBytes, e.quality);
      if (existing) updated++;
      else added++;
      insPath.run(e.path);
    }
    const delInfo = db.prepare("DELETE FROM media_files WHERE source_id = ? AND path NOT IN (SELECT path FROM sync_paths)").run(source.id);
    db.exec("COMMIT");
    const removed = Number(delInfo.changes);
    db.prepare("UPDATE sources SET last_sync_at = ?, last_sync_error = NULL WHERE id = ?").run(now, source.id);
    return { added, updated, removed, total: entries.length };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* not in transaction */ }
    throw err;
  }
}
