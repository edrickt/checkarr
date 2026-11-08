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

/**
 * A 200-JSON response is only trustworthy when it has the documented shape.
 * An auth proxy, an API-version mismatch, or a truncated body can answer with
 * valid JSON of the wrong shape; treating that as an empty library would make
 * the sync's cleanup delete every tracked row for the source. Wrong shapes are
 * therefore hard errors, never data.
 */
function expectList<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new Error(what + " returned a non-array response");
  return value as T[];
}

/** Same rule for an object body: null is the documented "not found" signal (a
 *  real HTTP 404, or an empty *arr DELETE); anything else that is not a plain
 *  object is an unexpected response and must never be read as absence. */
function expectObject(value: unknown, what: string): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error(what + " returned an unexpected response");
  return value as Record<string, unknown>;
}

function expectEntry<T>(value: unknown, what: string): T {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(what + " returned an entry that is not an object");
  return value as T;
}

/** The *arr API identifies every library item by a numeric id; a body without
 *  one (a proxy page object, an error envelope, an API-version change) is an
 *  unexpected response, not an item to track under the id "undefined". */
function requireNumericId(value: { id?: unknown }, what: string): void {
  if (typeof value.id !== "number" || !Number.isInteger(value.id))
    throw new Error(what + " returned an entry without a numeric id");
}

export async function fetchArr(
  baseUrl: string,
  apiKey: string,
  apiPath: string,
  init?: { method?: string; body?: unknown; notFoundOk?: boolean }
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
  if (res.status === 404 && init?.notFoundOk) return null;
  if (!res.ok) throw new Error(method + " " + apiPath + " failed: HTTP " + res.status + " " + res.statusText);
  if (text.trim().length === 0) {
    // *arr DELETE endpoints answer 204 (or 200) with an empty body, which is
    // success. An empty body on any other method is a broken response - an
    // auth proxy, a truncated transfer, a wrong URL - and must not be mistaken
    // for the null "item does not exist" signal.
    if (method === "DELETE") return null;
    throw new Error(method + " " + apiPath + " returned HTTP " + res.status + " with an empty body");
  }
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

/** One Radarr movie -> a sync entry, or null when the *arr does not track it
 *  (unmonitored with no file is not part of the library). */
function radarrEntry(m: RadarrMovie): SyncEntry | null {
  const f = m.movieFile;
  const filePath = f && typeof f.path === "string" && f.path.length > 0 ? f.path : null;
  if (filePath === null) {
    // The *arr API is the library's source of truth: a monitored movie
    // without a file is tracked as missing, not invisible.
    if (m.monitored === false) return null;
    return {
      externalId: String(m.id),
      title: String(m.title ?? "Untitled"),
      subtitle: typeof m.year === "number" ? String(m.year) : null,
      path: null,
      sizeBytes: null,
      quality: null
    };
  }
  return {
    externalId: String(m.id),
    title: String(m.title ?? "Untitled"),
    subtitle: typeof m.year === "number" ? String(m.year) : null,
    path: filePath,
    sizeBytes: typeof f?.size === "number" ? f.size : null,
    quality: qualityName(f?.quality)
  };
}

export async function radarrEntries(baseUrl: string, apiKey: string): Promise<SyncEntry[]> {
  const movies = expectList<RadarrMovie>(
    await fetchArr(baseUrl, apiKey, "/api/v3/movie"),
    "GET /api/v3/movie"
  );
  const out: SyncEntry[] = [];
  for (const raw of movies) {
    const m = expectEntry<RadarrMovie>(raw, "GET /api/v3/movie");
    requireNumericId(m, "GET /api/v3/movie");
    const e = radarrEntry(m);
    if (e !== null) out.push(e);
  }
  return out;
}

function padNumber(n?: number): string {
  return typeof n === "number" ? String(n).padStart(2, "0") : "??";
}

/** One Sonarr episode (with its series for the title) -> a sync entry, or
 *  null when the *arr does not track it. */
function sonarrEntry(s: SonarrSeries, e: SonarrEpisode): SyncEntry | null {
  const f = e.episodeFile;
  const filePath = f && typeof f.path === "string" && f.path.length > 0 ? f.path : null;
  const subtitle =
    "S" + padNumber(e.seasonNumber) + "E" + padNumber(e.episodeNumber) + (e.title ? " " + e.title : "");
  const title = String(s.title ?? "Series " + s.id);
  if (filePath === null) {
    // Same rule as Radarr: a monitored episode without a file is missing.
    if (e.monitored === false) return null;
    return {
      externalId: String(e.id),
      title,
      subtitle,
      path: null,
      sizeBytes: null,
      quality: null
    };
  }
  return {
    externalId: String(e.id),
    title,
    subtitle,
    path: filePath,
    sizeBytes: typeof f?.size === "number" ? f.size : null,
    quality: qualityName(f?.quality)
  };
}

export async function sonarrEntries(baseUrl: string, apiKey: string): Promise<SyncEntry[]> {
  const series = expectList<SonarrSeries>(
    await fetchArr(baseUrl, apiKey, "/api/v3/series"),
    "GET /api/v3/series"
  );
  const out: SyncEntry[] = [];
  // Sonarr's /api/v3/episode requires a seriesId (bare calls get HTTP 400) and only
  // embeds episodeFile when includeEpisodeFile=true, so fetch series by series.
  for (const rawSeries of series) {
    const s = expectEntry<SonarrSeries>(rawSeries, "GET /api/v3/series");
    requireNumericId(s, "GET /api/v3/series");
    const episodesUrl = "/api/v3/episode?seriesId=" + s.id + "&includeEpisodeFile=true";
    let episodes: SonarrEpisode[];
    try {
      episodes = expectList<SonarrEpisode>(
        await fetchArr(baseUrl, apiKey, episodesUrl),
        "GET " + episodesUrl
      );
    } catch (err) {
      throw new Error(
        "while listing episodes for '" +
          String(s.title ?? "series " + s.id) +
          "': " +
          String((err as Error)?.message ?? err),
        { cause: err }
      );
    }
    for (const rawEpisode of episodes) {
      const e = expectEntry<SonarrEpisode>(rawEpisode, "GET " + episodesUrl);
      requireNumericId(e, "GET " + episodesUrl);
      const entry = sonarrEntry(s, e);
      if (entry !== null) out.push(entry);
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
  const what = "GET /api/v3/system/status";
  try {
    const status = (await fetchArr(baseUrl, apiKey, "/api/v3/system/status")) as {
      appName?: unknown;
      version?: unknown;
    };
    if (status === null || typeof status !== "object" || Array.isArray(status)) {
      throw new Error(what + " returned an unexpected response");
    }
    // "It answered something" is not the same as "it is a Radarr/Sonarr":
    // an auth proxy or a truncated body must not be reported as a passing test.
    if (typeof status.appName !== "string" || status.appName.length === 0) {
      throw new Error(what + " did not identify the application (no appName)");
    }
    return {
      ok: true,
      appName: status.appName,
      version: typeof status.version === "string" ? status.version : undefined,
      mismatch: status.appName !== expected
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

export interface ItemSyncResult {
  /** false = the *arr no longer knows this item (gone, or unmonitored with
   *  no file): the row was removed, exactly as a full sync's cleanup would. */
  found: boolean;
  /** true = the refresh moved the row (relink, unfile, remove). A metadata
   *  refresh on an unchanged path does not count: verdicts stay intact. */
  changed: boolean;
}

/**
 * Refresh ONE media_files row from its *arr: the single-item equivalent of
 * syncSource. Single-item operations (re-check, per-file delete) run this
 * first so they act on what the *arr reports now instead of what the last
 * library sync saw - otherwise a movie downloaded after the last sync stays
 * 'missing' forever no matter how often it is re-checked.
 *
 * Same semantics as syncSource, scoped to the row:
 * - unchanged path: metadata refresh, verdicts kept
 * - file landed/moved to a free path: relink, verdicts reset to unchecked
 * - file gone: park as missing (a purged row stays purged)
 * - item untracked (404 / unmonitored with no file): row removed
 *
 * Network or auth failures throw; callers decide how to surface them.
 */
export async function syncOneItem(
  db: DB,
  source: SourceCore,
  row: { id: number; externalId: string }
): Promise<ItemSyncResult> {
  let entry: SyncEntry | null;
  if (source.type === "radarr") {
    const movieUrl = "/api/v3/movie/" + row.externalId;
    const m = expectObject(
      await fetchArr(source.base_url, source.api_key, movieUrl, { notFoundOk: true }),
      "GET " + movieUrl
    );
    if (m === null) entry = null;
    else {
      requireNumericId(m, "GET " + movieUrl);
      entry = radarrEntry(m as unknown as RadarrMovie);
    }
  } else {
    const episodeUrl = "/api/v3/episode/" + row.externalId + "?includeEpisodeFile=true";
    const e = expectObject(
      await fetchArr(source.base_url, source.api_key, episodeUrl, { notFoundOk: true }),
      "GET " + episodeUrl
    );
    if (e === null) {
      entry = null;
    } else if (typeof e.seriesId !== "number" || !Number.isInteger(e.seriesId)) {
      throw new Error("GET " + episodeUrl + " returned an unexpected response");
    } else {
      requireNumericId(e, "GET " + episodeUrl);
      const seriesUrl = "/api/v3/series/" + e.seriesId;
      const s = expectObject(
        await fetchArr(source.base_url, source.api_key, seriesUrl, { notFoundOk: true }),
        "GET " + seriesUrl
      );
      // A 404 for the series while its episode exists would mean the *arr no
      // longer knows the item; a wrong-shaped body (e.g. {}) is not that and
      // must not rewrite the row under a "Series undefined" title.
      if (s === null) entry = null;
      else {
        requireNumericId(s, "GET " + seriesUrl);
        entry = sonarrEntry(s as unknown as SonarrSeries, e as unknown as SonarrEpisode);
      }
    }
  }

  const kind = source.type === "radarr" ? "movie" : "episode";
  const currentPath = db.prepare("SELECT path FROM media_files WHERE id = ?").get(row.id) as
    { path: string | null } | undefined;

  if (entry === null) {
    // The *arr no longer tracks this item: drop the row, matching the full
    // sync's cleanup. Guarded so a concurrent removal is not an error.
    const info = db
      .prepare("DELETE FROM media_files WHERE id = ? AND source_id = ? AND kind = ? AND external_id = ?")
      .run(row.id, source.id, kind, row.externalId);
    return { found: false, changed: Number(info.changes) > 0 };
  }

  const now = new Date().toISOString();
  if (currentPath === undefined) return { found: false, changed: false };

  if (entry.path === null) {
    // Monitored but still no file: park the row as missing (a purged row
    // stays purged while it waits for the replacement). Already fileless:
    // nothing to change.
    if (currentPath.path === null) return { found: true, changed: false };
    db.prepare(
      "UPDATE media_files SET path = NULL, title = ?, subtitle = ?, size_bytes = NULL, quality = NULL," +
        " status = CASE WHEN status = 'purged' THEN 'purged' ELSE 'missing' END," +
        " error_detail = NULL, duration_s = NULL, container = NULL, video_codec = NULL," +
        " audio_codec = NULL, probe_json = NULL, checked_at = NULL, updated_at = ?" +
        " WHERE id = ? AND source_id = ? AND kind = ? AND external_id = ?"
    ).run(entry.title, entry.subtitle, now, row.id, source.id, kind, row.externalId);
    return { found: true, changed: true };
  }

  if (currentPath.path === entry.path) {
    // Same file as before: refresh metadata, keep every verdict.
    db.prepare(
      "UPDATE media_files SET title = ?, subtitle = ?, size_bytes = ?, quality = ?, updated_at = ? WHERE id = ?"
    ).run(entry.title, entry.subtitle, entry.sizeBytes, entry.quality, now, row.id);
    return { found: true, changed: false };
  }

  // New path. Relink only when nothing else owns it: paths are UNIQUE per
  // source, and a multi-episode file belongs to the row the last full sync
  // gave it to - leave this row alone and let the next full sync reconcile.
  const occupant = db
    .prepare("SELECT id FROM media_files WHERE source_id = ? AND path = ? AND id != ?")
    .get(source.id, entry.path, row.id);
  if (occupant !== undefined) return { found: true, changed: false };
  db.prepare(
    "UPDATE media_files SET path = ?, external_id = ?, title = ?, subtitle = ?, size_bytes = ?, quality = ?," +
      " status = 'unchecked', error_detail = NULL, duration_s = NULL, container = NULL, video_codec = NULL," +
      " audio_codec = NULL, probe_json = NULL, checked_at = NULL, updated_at = ?" +
      " WHERE id = ? AND source_id = ? AND kind = ? AND external_id = ?"
  ).run(
    entry.path,
    entry.externalId,
    entry.title,
    entry.subtitle,
    entry.sizeBytes,
    entry.quality,
    now,
    row.id,
    source.id,
    kind,
    row.externalId
  );
  return { found: true, changed: true };
}
