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
  movieFile?: { id?: number } | null;
}

interface SonarrEpisodeDetail {
  episodeFileId?: number | null;
}

/**
 * Radarr: resolve the movie's file id, delete the file (which removes it from
 * disk), then batch MoviesSearch so Radarr grabs replacements.
 */
async function purgeRadarr(source: PurgeRow, entries: PurgeRow[]): Promise<PurgeSourceResult> {
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
      const movie = (await fetchArr(source.base_url, source.api_key, "/api/v3/movie/" + movieId)) as RadarrMovieDetail;
      const fileId = movie?.movieFile?.id;
      if (!Number.isInteger(fileId)) {
        result.skipped++;
        return;
      }
      await fetchArr(source.base_url, source.api_key, "/api/v3/moviefile/" + fileId, { method: "DELETE" });
      result.deleted++;
      movieIds.push(movieId);
    } catch (err) {
      result.errors.push(e.path + ": " + String((err as Error)?.message ?? err));
    }
  });
  if (movieIds.length > 0) {
    await fetchArr(source.base_url, source.api_key, "/api/v3/command", {
      method: "POST",
      body: { name: "MoviesSearch", movieIds }
    });
    result.searched = movieIds.length;
  }
  return result;
}

/**
 * Sonarr: resolve the episode's file id, delete it, then batch EpisodesSearch.
 */
async function purgeSonarr(source: PurgeRow, entries: PurgeRow[]): Promise<PurgeSourceResult> {
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
      const episode = (await fetchArr(source.base_url, source.api_key, "/api/v3/episode/" + episodeId)) as SonarrEpisodeDetail;
      const fileId = episode?.episodeFileId;
      if (!Number.isInteger(fileId)) {
        result.skipped++;
        return;
      }
      await fetchArr(source.base_url, source.api_key, "/api/v3/episodefile/" + fileId, { method: "DELETE" });
      result.deleted++;
      episodeIds.push(episodeId);
    } catch (err) {
      result.errors.push(e.path + ": " + String((err as Error)?.message ?? err));
    }
  });
  if (episodeIds.length > 0) {
    await fetchArr(source.base_url, source.api_key, "/api/v3/command", {
      method: "POST",
      body: { name: "EpisodesSearch", episodeIds }
    });
    result.searched = episodeIds.length;
  }
  return result;
}

/**
 * Delete every corrupt file at its *arr source and queue searches for
 * replacements. Only enabled sources are touched; files whose *arr record no
 * longer references a file are counted as skipped. Statuses in Checkarr are
 * left alone - a later sync + scan reflects the new reality.
 */
export async function purgeCorrupt(db: DB): Promise<PurgeResult> {
  const rows = db
    .prepare(
      "SELECT mf.id, mf.external_id, mf.path, s.id AS source_id, s.type, s.name, s.base_url, s.api_key" +
        " FROM media_files mf JOIN sources s ON s.id = mf.source_id" +
        " WHERE mf.status = 'corrupt' AND s.enabled = 1 ORDER BY s.id, mf.id"
    )
    .all() as unknown as PurgeRow[];

  const bySource = new Map<number, { source: PurgeRow; entries: PurgeRow[] }>();
  for (const r of rows) {
    const group = bySource.get(r.source_id) ?? { source: r, entries: [] };
    group.entries.push(r);
    bySource.set(r.source_id, group);
  }

  const results: PurgeSourceResult[] = [];
  for (const { source, entries } of bySource.values()) {
    results.push(source.type === "sonarr" ? await purgeSonarr(source, entries) : await purgeRadarr(source, entries));
  }
  return { results, total: results.reduce((n, r) => n + r.deleted, 0) };
}
