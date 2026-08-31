import type { DB } from "../db.js";

export interface SyncEntry {
  externalId: string;
  title: string;
  subtitle: string | null;
  /** null = the *arr API reports this monitored item but has no file for it
   *  (not downloaded yet, or deleted awaiting a replacement). */
  path: string | null;
  sizeBytes: number | null;
  quality: string | null;
}

export interface SyncResult {
  added: number;
  /** Same movie/episode whose file landed under a new path (replacement
   *  download with different release tags, upgrade, rename): row kept, path
   *  swapped, verdict reset. */
  relinked: number;
  updated: number;
  removed: number;
  total: number;
}

function trimSlashes(s: string): string {
  let out = s;
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

export async function fetchArr(
  baseUrl: string,
  apiKey: string,
  apiPath: string,
  init?: { method?: string; body?: unknown }
): Promise<unknown> {
  const root = trimSlashes(baseUrl);
  const method = init?.method ?? "GET";
  let res: Response;
  let text: string;
  try {
    res = await fetch(root + apiPath, {
      method,
      headers: {
        "X-Api-Key": apiKey,
        Accept: "application/json",
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {})
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000)
    });
    // Radarr/Sonarr delete endpoints answer with an empty body; consume as
    // text and parse only when non-empty so a successful delete never throws.
    text = await res.text();
  } catch (err) {
    throw new Error("Cannot reach " + root + " : " + String((err as Error)?.message ?? err), { cause: err });
  }
  if (res.status === 401) throw new Error("Unauthorized (401) - check the API key");
  if (!res.ok) throw new Error(method + " " + apiPath + " failed: HTTP " + res.status + " " + res.statusText);
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(method + " " + apiPath + " returned HTTP " + res.status + " with a non-JSON body");
  }
}

interface QualityWrapped {
  quality?: { name?: string } | null;
}

interface RadarrMovie {
  id: number;
  title: string;
  year?: number;
  monitored?: boolean;
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
  monitored?: boolean;
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
    const filePath = f && typeof f.path === "string" && f.path.length > 0 ? f.path : null;
    if (filePath === null) {
      // The *arr API is the library's source of truth: a monitored movie
      // without a file is tracked as missing, not invisible.
      if (m.monitored === false) continue;
      out.push({
        externalId: String(m.id),
        title: String(m.title ?? "Untitled"),
        subtitle: typeof m.year === "number" ? String(m.year) : null,
        path: null,
        sizeBytes: null,
        quality: null
      });
      continue;
    }
    out.push({
      externalId: String(m.id),
      title: String(m.title ?? "Untitled"),
      subtitle: typeof m.year === "number" ? String(m.year) : null,
      path: filePath,
      sizeBytes: typeof f?.size === "number" ? f.size : null,
      quality: qualityName(f?.quality)
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
      episodes = (await fetchArr(
        baseUrl,
        apiKey,
        "/api/v3/episode?seriesId=" + s.id + "&includeEpisodeFile=true"
      )) as SonarrEpisode[];
    } catch (err) {
      throw new Error(
        "while listing episodes for '" +
          String(s.title ?? "series " + s.id) +
          "': " +
          String((err as Error)?.message ?? err),
        { cause: err }
      );
    }
    for (const e of Array.isArray(episodes) ? episodes : []) {
      const f = e.episodeFile;
      const filePath = f && typeof f.path === "string" && f.path.length > 0 ? f.path : null;
      if (filePath === null) {
        // Same rule as Radarr: a monitored episode without a file is missing.
        if (e.monitored === false) continue;
        out.push({
          externalId: String(e.id),
          title: String(s.title ?? "Series " + s.id),
          subtitle: "S" + pad(e.seasonNumber) + "E" + pad(e.episodeNumber) + (e.title ? " " + e.title : ""),
          path: null,
          sizeBytes: null,
          quality: null
        });
        continue;
      }
      out.push({
        externalId: String(e.id),
        title: String(s.title ?? "Series " + s.id),
        subtitle: "S" + pad(e.seasonNumber) + "E" + pad(e.episodeNumber) + (e.title ? " " + e.title : ""),
        path: filePath,
        sizeBytes: typeof f?.size === "number" ? f.size : null,
        quality: qualityName(f?.quality)
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
    const status = (await fetchArr(baseUrl, apiKey, "/api/v3/system/status")) as {
      appName?: string;
      version?: string;
    };
    const appName = status?.appName ?? undefined;
    return {
      ok: true,
      appName,
      version: status?.version,
      mismatch: appName !== undefined && appName !== expected
    };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

/**
 * Pull the library from one source and upsert into media_files. The *arr API
 * is the source of truth: every monitored movie/episode gets a row, file or
 * not - fileless items are parked as missing with a NULL path.
 * Identity is (source_id, path) for file rows: same-path rows keep their
 * verdicts. When the *arr reports a tracked item under a new path, the row is
 * relinked to the new file and reset to unchecked (the old verdict described
 * bytes that are gone); when it reports a tracked item with no file, the row
 * is parked as missing (a purged row stays purged until the replacement
 * lands). Rows the *arr no longer knows are removed.
 */
export async function syncSource(db: DB, source: SourceCore): Promise<SyncResult> {
  const entries =
    source.type === "radarr"
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
  // The *arr reports a movie/episode we already track under a different path:
  // a replacement download (Delete & re-search) lands in the same folder with
  // different release tags, a manual upgrade or a rename. Relink the row so
  // its id (and scan history) survives, and reset the verdict - the old
  // findings describe bytes that no longer exist.
  const byExternalStmt = db.prepare(
    "SELECT id FROM media_files WHERE source_id = ? AND kind = ? AND external_id = ? ORDER BY id LIMIT 1"
  );
  const relinkStmt = db.prepare(
    "UPDATE media_files SET path = ?, external_id = ?, title = ?, subtitle = ?, size_bytes = ?, quality = ?," +
      " status = 'unchecked', error_detail = NULL, duration_s = NULL, container = NULL, video_codec = NULL," +
      " audio_codec = NULL, probe_json = NULL, checked_at = NULL, updated_at = ?" +
      " WHERE id = ? AND source_id = ? AND kind = ? AND external_id = ?"
  );
  const insertStmt = db.prepare(
    "INSERT INTO media_files (source_id, kind, external_id, title, subtitle, path, size_bytes, quality)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  // The *arr monitors this item but has no file: park the row as missing
  // with no path until a sync brings the file in. A purged row keeps its
  // status while the replacement search is still pending.
  const unfileStmt = db.prepare(
    "UPDATE media_files SET path = NULL, title = ?, subtitle = ?, size_bytes = NULL, quality = NULL," +
      " status = CASE WHEN status = 'purged' THEN 'purged' ELSE 'missing' END," +
      " error_detail = NULL, duration_s = NULL, container = NULL, video_codec = NULL," +
      " audio_codec = NULL, probe_json = NULL, checked_at = NULL, updated_at = ?" +
      " WHERE id = ? AND source_id = ? AND kind = ? AND external_id = ?"
  );
  const insertMissingStmt = db.prepare(
    "INSERT INTO media_files (source_id, kind, external_id, title, subtitle, path, size_bytes, quality, status)" +
      " VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'missing')"
  );
  let added = 0;
  let relinked = 0;
  let updated = 0;

  db.exec("CREATE TEMP TABLE IF NOT EXISTS sync_paths (path TEXT PRIMARY KEY)");
  db.exec("DELETE FROM sync_paths");
  const insPath = db.prepare("INSERT OR IGNORE INTO sync_paths (path) VALUES (?)");
  // Every entry's id, fileless or not: a fileless row whose item left the
  // *arr entirely must be removed (NULL paths never match NOT IN cleanup).
  db.exec("CREATE TEMP TABLE IF NOT EXISTS sync_seen (external_id TEXT PRIMARY KEY)");
  db.exec("DELETE FROM sync_seen");
  const insSeen = db.prepare("INSERT OR IGNORE INTO sync_seen (external_id) VALUES (?)");

  db.exec("BEGIN");
  try {
    for (const e of entries) {
      if (e.path === null) {
        const twin = byExternalStmt.get(source.id, kind, e.externalId) as { id: number } | undefined;
        if (twin) {
          unfileStmt.run(e.title, e.subtitle, now, twin.id, source.id, kind, e.externalId);
          updated++;
        } else {
          insertMissingStmt.run(source.id, kind, e.externalId, e.title, e.subtitle);
          added++;
        }
        insSeen.run(e.externalId);
        continue;
      }
      const existing = existsStmt.get(source.id, e.path);
      if (existing) {
        upsertStmt.run(source.id, kind, e.externalId, e.title, e.subtitle, e.path, e.sizeBytes, e.quality);
        updated++;
      } else {
        const twin = byExternalStmt.get(source.id, kind, e.externalId) as { id: number } | undefined;
        if (twin) {
          relinkStmt.run(
            e.path,
            e.externalId,
            e.title,
            e.subtitle,
            e.sizeBytes,
            e.quality,
            now,
            twin.id,
            source.id,
            kind,
            e.externalId
          );
          relinked++;
        } else {
          insertStmt.run(source.id, kind, e.externalId, e.title, e.subtitle, e.path, e.sizeBytes, e.quality);
          added++;
        }
      }
      insPath.run(e.path);
      insSeen.run(e.externalId);
    }
    const delInfo = db
      .prepare(
        "DELETE FROM media_files WHERE source_id = ? AND" +
          " ((path IS NOT NULL AND path NOT IN (SELECT path FROM sync_paths))" +
          "  OR (path IS NULL AND external_id NOT IN (SELECT external_id FROM sync_seen)))"
      )
      .run(source.id);
    db.exec("COMMIT");
    const removed = Number(delInfo.changes);
    db.prepare("UPDATE sources SET last_sync_at = ?, last_sync_error = NULL WHERE id = ?").run(
      now,
      source.id
    );
    return { added, relinked, updated, removed, total: entries.length };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* not in transaction */
    }
    throw err;
  }
}
