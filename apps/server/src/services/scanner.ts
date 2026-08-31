import type { DB } from "../db.js";
import { getSettings, type PathMapping } from "../settings.js";
import { binariesUsable, resolveBinaries, type Binaries } from "./ffmpeg.js";
import { checkMediaFile, type CheckContext, type CheckOutcome } from "./checker.js";
import { ApiError } from "../lib/api-error.js";

const NL = String.fromCharCode(10);

export interface ClaimedItem {
  id: number;
  media_file_id: number;
}

export function persistOutcome(db: DB, fileId: number, outcome: CheckOutcome): void {
  const now = new Date().toISOString();
  const probe = outcome.probe;
  db.prepare(
    "UPDATE media_files SET status = ?, error_detail = ?, duration_s = ?, container = ?, video_codec = ?," +
      " audio_codec = ?, probe_json = ?, checked_at = ?, updated_at = ? WHERE id = ?"
  ).run(
    outcome.status,
    outcome.detail,
    probe?.durationS ?? null,
    probe?.container ?? null,
    probe?.videoCodec ?? null,
    probe?.audioCodec ?? null,
    probe ? JSON.stringify(probe) : null,
    now,
    now,
    fileId
  );
}

export function resumeInterruptedScans(db: DB): void {
  db.prepare("UPDATE scan_items SET state = 'pending' WHERE state = 'running'").run();
  db.prepare("UPDATE scan_runs SET state = 'cancelled', finished_at = ? WHERE state = 'running'").run(new Date().toISOString());
}

export class ScanManager {
  private db: DB;
  private running = false;
  private cancelled = false;
  private activeRunId: number | null = null;
  private cancelController: AbortController | null = null;

  constructor(db: DB) {
    this.db = db;
  }

  isActive(): boolean {
    return this.running;
  }

  currentRun(): Record<string, unknown> | null {
    if (this.activeRunId === null) return null;
    const row = this.db
      .prepare(
        "SELECT r.id, r.scope, r.state, r.total, r.done, r.issues, r.started_at AS startedAt, r.finished_at AS finishedAt," +
          " r.source_id AS sourceId, s.name AS sourceName" +
          " FROM scan_runs r LEFT JOIN sources s ON s.id = r.source_id WHERE r.id = ?"
      )
      .get(this.activeRunId) as Record<string, unknown> | undefined;
    if (!row) return null;
    // Cancel feedback must be instant: surface "cancelling" from memory the
    // moment cancel() lands instead of waiting for workers to drain. The DB
    // row stays 'running' (CHECK constraint) until drive() writes the verdict.
    if (this.cancelled) row.state = "cancelling";
    return row;
  }

  async start(scope: "unchecked" | "all", sourceId?: number): Promise<number> {
    if (this.running) throw new ApiError(409, "A scan is already running");
    this.cancelled = false;
    const settings = getSettings(this.db);
    const binaries = resolveBinaries(settings);
    const problem = await binariesUsable(binaries);
    if (problem) throw new ApiError(400, problem);
    // A cancel that lands while validating takes effect before anything starts.
    if (this.cancelled) throw new ApiError(409, "Scan cancelled before it started");

    // Set-based item creation: one COUNT plus one INSERT..SELECT. The old
    // per-row INSERT loop held the event loop for seconds on large libraries,
    // which is exactly why pressing "scan" felt unresponsive.
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (scope === "unchecked") clauses.push("status = 'unchecked'");
    if (sourceId !== undefined) {
      clauses.push("source_id = ?");
      params.push(sourceId);
    }
    const where = clauses.length > 0 ? " WHERE " + clauses.join(" AND ") : "";
    const countRow = this.db.prepare("SELECT COUNT(*) AS n FROM media_files" + where).get(...params) as { n: number };
    const total = Number(countRow.n);
    if (total === 0) {
      throw new ApiError(400, "No files match the scan scope" + (sourceId !== undefined ? " for source " + sourceId : ""));
    }

    const runRes = this.db
      .prepare("INSERT INTO scan_runs (mode, scope, source_id, state, total, started_at) VALUES ('quick', ?, ?, 'running', ?, ?)")
      .run(scope, sourceId ?? null, total, new Date().toISOString());
    const runId = Number(runRes.lastInsertRowid);
    this.db
      .prepare("INSERT INTO scan_items (run_id, media_file_id) SELECT ?, id FROM media_files" + where + " ORDER BY id")
      .run(runId, ...params);

    this.running = true;
    this.activeRunId = runId;
    this.cancelController = new AbortController();
    void this.drive(runId, binaries, settings.pathMappings, settings.concurrency);
    return runId;
  }

  /** Marks the run cancelled immediately: currentRun() reports "cancelling"
   *  right away and in-flight ffmpeg/ffprobe processes are killed. */
  cancel(): void {
    this.cancelled = true;
    this.cancelController?.abort();
  }

  private async drive(
    runId: number,
    binaries: Binaries,
    mappings: PathMapping[],
    concurrency: number
  ): Promise<void> {
    try {
      const n = Math.min(32, Math.max(1, concurrency));
      // Exactly one decode thread per worker, so total ffmpeg threads always
      // equal the worker count no matter the hardware. The machine keeps its
      // headroom; raise concurrency if you want more decode throughput.
      const threads = 1;
      const ctx: CheckContext = { binaries, mappings, threads, signal: this.cancelController?.signal };
      const workers: Promise<void>[] = [];
      for (let i = 0; i < n; i++) workers.push(this.worker(runId, ctx));
      await Promise.all(workers);
    } catch (err) {
      console.error("scan run " + runId + " crashed:" + NL + String((err as Error)?.stack ?? err));
    } finally {
      const state = this.cancelled ? "cancelled" : "done";
      this.db.prepare("UPDATE scan_runs SET state = ?, finished_at = ? WHERE id = ?").run(state, new Date().toISOString(), runId);
      this.cancelController = null;
      this.running = false;
      // The run is settled: drop the flag so currentRun() reports the final
      // DB state ("cancelled") instead of an endless in-memory "cancelling".
      this.cancelled = false;
    }
  }

  private async worker(runId: number, ctx: CheckContext): Promise<void> {
    for (;;) {
      if (this.cancelled) return;
      const item = this.claim(runId);
      if (!item) return;
      const file = this.db.prepare("SELECT id, path FROM media_files WHERE id = ?").get(item.media_file_id) as
        | { id: number; path: string }
        | undefined;
      if (!file) {
        this.db.prepare("UPDATE scan_items SET state = 'skipped' WHERE id = ?").run(item.id);
        continue;
      }
      let outcome: CheckOutcome;
      try {
        outcome = await checkMediaFile(file.path, ctx);
      } catch (err) {
        if (this.cancelled) {
          // Cancelled mid-file: the in-flight check was killed on purpose, so
          // leave the item pending instead of persisting a bogus verdict.
          this.db.prepare("UPDATE scan_items SET state = 'pending' WHERE id = ?").run(item.id);
          return;
        }
        outcome = { status: "suspect", detail: "checker error: " + String((err as Error)?.message ?? err), probe: null };
      }
      persistOutcome(this.db, file.id, outcome);
      this.db.prepare("UPDATE scan_items SET state = 'done' WHERE id = ?").run(item.id);
      this.db
        .prepare("UPDATE scan_runs SET done = done + 1, issues = issues + ? WHERE id = ?")
        .run(outcome.status === "healthy" ? 0 : 1, runId);
    }
  }

  /** Synchronous claim between awaits is race-free in the single-threaded event loop. */
  private claim(runId: number): ClaimedItem | null {
    const item = this.db
      .prepare("SELECT id, media_file_id FROM scan_items WHERE run_id = ? AND state = 'pending' ORDER BY id LIMIT 1")
      .get(runId) as unknown as ClaimedItem | undefined;
    if (!item) return null;
    this.db.prepare("UPDATE scan_items SET state = 'running' WHERE id = ?").run(item.id);
    return item;
  }
}
