import type { DB } from "../db.js";
import { fetchArr } from "./sync.js";

export interface PurgeSourceResult {
  sourceId: number;
  name: string;
  type: string;
  deleted: number;
  searched: number;
  skipped: number;
  errors: string[];
}

export interface PurgeResult {
  results: PurgeSourceResult[];
  total: number;
}

interface PurgeRow {
  id: number;
  external_id: string;
  path: string;
  source_id: number;
  type: string;
  name: string;
  base_url: string;
  api_key: string;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

interface RadarrMovieDetail {
  movieFile?: { id?: number; path?: string } | null;
}

interface SonarrEpisodeDetail {
  episodeFileId?: number | null;
  episodeFile?: { id?: number; path?: string } | null;
}

/** Compare *arr-reported paths, normalizing Windows separators. */
function sameArrPath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
}

/**
 * Radarr: resolve the movie's file id, delete the file (which removes it from
 * disk), then batch MoviesSearch so Radarr grabs replacements.
 */
async function purgeRadarr(
  source: PurgeRow,
  entries: PurgeRow[],
  onDeleted: (rowId: number) => void
): Promise<PurgeSourceResult> {
  const result: PurgeSourceResult = {
    sourceId: source.source_id,
    name: source.name,
    type: "radarr",
    deleted: 0,
    searched: 0,
    skipped: 0,
    errors: []
  };
  const movieIds: number[] = [];
  await mapLimit(entries, 4, async (e) => {
    const movieId = Number(e.external_id);
    try {
      const movie = (await fetchArr(
        source.base_url,
        source.api_key,
        "/api/v3/movie/" + movieId
      )) as RadarrMovieDetail;
      const file = movie?.movieFile ?? null;
      const fileId = file?.id;
      if (!Number.isInteger(fileId)) {
        result.skipped++;
        return;
      }
      // Only delete when the *arr file is still the one we checked: a stale
      // row (file replaced or moved since the scan) must not cost a good file.
      const currentPath = typeof file?.path === "string" ? file.path : null;
      if (currentPath === null || !sameArrPath(currentPath, e.path)) {
        result.skipped++;
        result.errors.push(
          e.path +
            ": *arr now points at " +
            (currentPath ?? "no file") +
            " - re-sync and re-scan, then purge again"
        );
        return;
      }
      await fetchArr(source.base_url, source.api_key, "/api/v3/moviefile/" + fileId, { method: "DELETE" });
      result.deleted++;
      movieIds.push(movieId);
      onDeleted(e.id);
    } catch (err) {
      result.errors.push(e.path + ": " + String((err as Error)?.message ?? err));
    }
  });
  if (movieIds.length > 0) {
    try {
      await fetchArr(source.base_url, source.api_key, "/api/v3/command", {
        method: "POST",
        body: { name: "MoviesSearch", movieIds }
      });
      result.searched = movieIds.length;
    } catch (err) {
      result.errors.push("replacement search failed: " + String((err as Error)?.message ?? err));
    }
  }
  return result;
}

/**
 * Sonarr: resolve the episode's file id, delete it, then batch EpisodesSearch.
 */
async function purgeSonarr(
  source: PurgeRow,
  entries: PurgeRow[],
  onDeleted: (rowId: number) => void
): Promise<PurgeSourceResult> {
  const result: PurgeSourceResult = {
    sourceId: source.source_id,
    name: source.name,
    type: "sonarr",
    deleted: 0,
    searched: 0,
    skipped: 0,
    errors: []
  };
  const episodeIds: number[] = [];
  await mapLimit(entries, 4, async (e) => {
    const episodeId = Number(e.external_id);
    try {
      // includeEpisodeFile=true embeds the file (with its path) so we can
      // verify it is still the episode file we checked before deleting it.
      const episode = (await fetchArr(
        source.base_url,
        source.api_key,
        "/api/v3/episode/" + episodeId + "?includeEpisodeFile=true"
      )) as SonarrEpisodeDetail;
      const file = episode?.episodeFile ?? null;
      const fileId = typeof episode?.episodeFileId === "number" ? episode.episodeFileId : file?.id;
      if (!Number.isInteger(fileId)) {
        result.skipped++;
        return;
      }
      const currentPath = typeof file?.path === "string" ? file.path : null;
      if (currentPath === null || !sameArrPath(currentPath, e.path)) {
        result.skipped++;
        result.errors.push(
          e.path +
            ": *arr now points at " +
            (currentPath ?? "no file") +
            " - re-sync and re-scan, then purge again"
        );
        return;
      }
      await fetchArr(source.base_url, source.api_key, "/api/v3/episodefile/" + fileId, { method: "DELETE" });
      result.deleted++;
      episodeIds.push(episodeId);
      onDeleted(e.id);
    } catch (err) {
      result.errors.push(e.path + ": " + String((err as Error)?.message ?? err));
    }
  });
  if (episodeIds.length > 0) {
    try {
      await fetchArr(source.base_url, source.api_key, "/api/v3/command", {
        method: "POST",
        body: { name: "EpisodesSearch", episodeIds }
      });
      result.searched = episodeIds.length;
    } catch (err) {
      result.errors.push("replacement search failed: " + String((err as Error)?.message ?? err));
    }
  }
  return result;
}

export interface PurgeFilter {
  /** Only touch files with this status; omit, or "all", for every status. */
  status?: string;
  /** Restrict to a single media_files row (per-file purge from the library). */
  fileId?: number;
  /** Restrict to one *arr source (the dashboard's server picker). */
  sourceId?: number;
}

/**
 * Delete files at their *arr sources and queue searches for replacements,
 * selected by filter among enabled sources only. Files whose *arr record no
 * longer references a file are counted as skipped. Every deleted file moves
 * to the 'purged' status: it is gone from disk (the replacement search is
 * batched per source and its failure is reported in the errors), and the
 * next sync drops the row (or swaps in the new download, which arrives as a
 * fresh unchecked file at its new path).
 */
export async function purgeFiles(db: DB, filter: PurgeFilter = {}): Promise<PurgeResult> {
  const now = new Date().toISOString();
  const markPurged = db.prepare("UPDATE media_files SET status = 'purged', updated_at = ? WHERE id = ?");
  let sql =
    "SELECT mf.id, mf.external_id, mf.path, s.id AS source_id, s.type, s.name, s.base_url, s.api_key" +
    " FROM media_files mf JOIN sources s ON s.id = mf.source_id" +
    " WHERE s.enabled = 1";
  const params: string[] = [];
  if (filter.status !== undefined && filter.status !== "all") {
    sql += " AND mf.status = ?";
    params.push(filter.status);
  }
  if (filter.fileId !== undefined) {
    sql += " AND mf.id = ?";
    params.push(String(filter.fileId));
  }
  if (filter.sourceId !== undefined) {
    sql += " AND mf.source_id = ?";
    params.push(String(filter.sourceId));
  }
  sql += " ORDER BY s.id, mf.id";
  const rows = db.prepare(sql).all(...params) as unknown as PurgeRow[];

  const bySource = new Map<number, { source: PurgeRow; entries: PurgeRow[] }>();
  for (const r of rows) {
    const group = bySource.get(r.source_id) ?? { source: r, entries: [] };
    group.entries.push(r);
    bySource.set(r.source_id, group);
  }

  const results: PurgeSourceResult[] = [];
  for (const { source, entries } of bySource.values()) {
    const deletedIds: number[] = [];
    const onDeleted = (rowId: number): void => {
      deletedIds.push(rowId);
      markPurged.run(now, rowId);
    };
    // One failing source must not hide what already happened elsewhere or
    // skip the remaining sources: report the failure and keep going.
    try {
      results.push(
        source.type === "sonarr"
          ? await purgeSonarr(source, entries, onDeleted)
          : await purgeRadarr(source, entries, onDeleted)
      );
    } catch (err) {
      results.push({
        sourceId: source.source_id,
        name: source.name,
        type: source.type,
        deleted: 0,
        searched: 0,
        skipped: 0,
        errors: ["purge failed: " + String((err as Error)?.message ?? err)]
      });
    }
  }
  return { results, total: results.reduce((n, r) => n + r.deleted, 0) };
}

/** Delete every corrupt file at its *arr source; the dashboard's one-click purge. */
export async function purgeCorrupt(db: DB): Promise<PurgeResult> {
  return purgeFiles(db, { status: "corrupt" });
}
