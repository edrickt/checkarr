import type { DB } from "../db.js";
import { fetchArr } from "./sync.js";

export interface ResearchSourceResult {
  sourceId: number;
  name: string;
  type: string;
  /** Items a search command was queued for. */
  searched: number;
  /** Missing rows whose *arr item no longer exists (should not happen after a sync). */
  skipped: number;
  errors: string[];
}

export interface ResearchResult {
  results: ResearchSourceResult[];
  total: number;
}

interface MissingRow {
  id: number;
  external_id: string;
  source_id: number;
  type: string;
  name: string;
  base_url: string;
  api_key: string;
}

/**
 * *arr search commands have a per-command payload; keep each batch modest so
 * a library-wide re-search of thousands of episodes does not produce one
 * giant request. Counts stay cumulative across chunks.
 */
const SEARCH_CHUNK = 200;

async function chunkedSearch(
  source: MissingRow,
  command: string,
  key: "movieIds" | "episodeIds",
  ids: number[],
  errors: string[]
): Promise<number> {
  let queued = 0;
  for (let i = 0; i < ids.length; i += SEARCH_CHUNK) {
    const chunk = ids.slice(i, i + SEARCH_CHUNK);
    try {
      await fetchArr(source.base_url, source.api_key, "/api/v3/command", {
        method: "POST",
        body: { name: command, [key]: chunk }
      });
      queued += chunk.length;
    } catch (err) {
      errors.push("search command failed: " + String((err as Error)?.message ?? err));
    }
  }
  return queued;
}

/**
 * Queue interactive searches at the *arr for every 'missing' item (monitored
 * at the *arr with no file) among enabled sources, optionally scoped to one.
 * A sync should have run first (the route does), so every row still points at
 * a live *arr item; unknown ids are simply skipped by the *arr. Rows are left
 * 'missing' until a download lands and the next sync relinks them.
 */
export async function researchMissing(db: DB, filter: { sourceId?: number } = {}): Promise<ResearchResult> {
  let sql =
    "SELECT mf.id, mf.external_id, s.id AS source_id, s.type, s.name, s.base_url, s.api_key" +
    " FROM media_files mf JOIN sources s ON s.id = mf.source_id" +
    " WHERE s.enabled = 1 AND mf.status = 'missing'";
  const params: (string | number)[] = [];
  if (filter.sourceId !== undefined) {
    sql += " AND mf.source_id = ?";
    params.push(filter.sourceId);
  }
  sql += " ORDER BY s.id, mf.id";
  const rows = db.prepare(sql).all(...params) as unknown as MissingRow[];

  const bySource = new Map<number, { source: MissingRow; entries: MissingRow[] }>();
  for (const r of rows) {
    const group = bySource.get(r.source_id) ?? { source: r, entries: [] };
    group.entries.push(r);
    bySource.set(r.source_id, group);
  }

  const results: ResearchSourceResult[] = [];
  for (const { source, entries } of bySource.values()) {
    const result: ResearchSourceResult = {
      sourceId: source.source_id,
      name: source.name,
      type: source.type,
      searched: 0,
      skipped: 0,
      errors: []
    };
    const ids = [
      ...new Set(entries.map((e) => Number(e.external_id)).filter((n) => Number.isInteger(n) && n > 0))
    ];
    result.skipped = entries.length - ids.length;
    // One failing source must not block the others - same rule as purge.
    try {
      if (source.type === "radarr") {
        result.searched += await chunkedSearch(source, "MoviesSearch", "movieIds", ids, result.errors);
      } else {
        result.searched += await chunkedSearch(source, "EpisodesSearch", "episodeIds", ids, result.errors);
      }
    } catch (err) {
      result.errors.push("re-search failed: " + String((err as Error)?.message ?? err));
    }
    results.push(result);
  }
  return { results, total: results.reduce((n, r) => n + r.searched, 0) };
}
