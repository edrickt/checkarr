import type { DB } from "../db.js";
import { getSettings, type PathMapping } from "../settings.js";
import { binariesUsable, resolveBinaries, type Binaries } from "./ffmpeg.js";
import { checkMediaFile, type CheckContext, type CheckOutcome } from "./checker.js";
import { ApiError } from "../lib/api-error.js";

const NL = String.fromCharCode(10);

/** What a scan can target: one file status, or everything. */
export type ScanScope = "unchecked" | "corrupt" | "suspect" | "missing" | "unreachable" | "purged" | "all";

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

export type PersistVerdict =
  | { wrote: true; status: CheckOutcome["status"] }
  | { wrote: false; reason: "row-changed" | "purged-awaiting-replacement" };

/**
 * Write a finished check back to its row, guarded by the two rules a disk
 * verdict must satisfy before it may land:
 * - A sync can relink the row to a replacement download (or remove it) while
 *   the check runs; a verdict computed from the old path must not overwrite
 *   the new file's state, so it is discarded when the path has moved.
 * - A purged row ("Delete & re-search") is expected to have no file on disk
 *   until the replacement lands: a re-check that finds it gone keeps the row
 *   purged instead of demoting it to 'missing'. Sync swaps in the new
 *   download (even under a different filename) or drops the row.
 */
export function persistCheckOutcome(
  db: DB,
  file: { id: number; path: string; status: string },
  outcome: CheckOutcome
): PersistVerdict {
  const cur = db.prepare("SELECT path FROM media_files WHERE id = ?").get(file.id) as
    { path: string } | undefined;
  if (!cur || cur.path !== file.path) return { wrote: false, reason: "row-changed" };
  if (file.status === "purged" && outcome.status === "missing") {
    return { wrote: false, reason: "purged-awaiting-replacement" };
  }
  persistOutcome(db, file.id, outcome);
  return { wrote: true, status: outcome.status };
}

export function resumeInterruptedScans(db: DB): void {
  db.prepare("UPDATE scan_items SET state = 'pending' WHERE state = 'running'").run();
  db.prepare("UPDATE scan_runs SET state = 'cancelled', finished_at = ? WHERE state = 'running'").run(
    new Date().toISOString()
  );
}

export class ScanManager {
  private db: DB;
  private running = false;
  private cancelled = false;
  private failed = false;
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

  async start(scope: ScanScope, sourceId?: number): Promise<number> {
    // Claim synchronously, before any await: binariesUsable below spawns two
    // processes (~hundreds of ms), and two overlapping requests would both
    // pass an async gate and launch two full scans (reproduced in audit).
    if (this.running) throw new ApiError(409, "A scan is already running");
    this.running = true;
    this.cancelled = false;
    this.failed = false;
    try {
      return await this.begin(scope, sourceId);
    } catch (err) {
      this.running = false;
      this.activeRunId = null;
      this.cancelController = null;
      this.cancelled = false;
      this.failed = false;
      throw err;
    }
  }

  private async begin(scope: ScanScope, sourceId?: number): Promise<number> {
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
    // "all" scans everything; every other scope targets one file status.
    if (scope !== "all") {
      clauses.push("status = ?");
      params.push(scope);
    }
    if (sourceId !== undefined) {
      clauses.push("source_id = ?");
      params.push(sourceId);
    }
    const where = clauses.length > 0 ? " WHERE " + clauses.join(" AND ") : "";
    const countRow = this.db.prepare("SELECT COUNT(*) AS n FROM media_files" + where).get(...params) as {
      n: number;
    };
    const total = Number(countRow.n);
    if (total === 0) {
      throw new ApiError(
        400,
        "No files match the scan scope" + (sourceId !== undefined ? " for source " + sourceId : "")
      );
    }

    const runRes = this.db
      .prepare(
        "INSERT INTO scan_runs (mode, scope, source_id, state, total, started_at) VALUES ('quick', ?, ?, 'running', ?, ?)"
      )
      .run(scope, sourceId ?? null, total, new Date().toISOString());
    const runId = Number(runRes.lastInsertRowid);
    this.db
      .prepare(
        "INSERT INTO scan_items (run_id, media_file_id) SELECT ?, id FROM media_files" +
          where +
          " ORDER BY id"
      )
      .run(runId, ...params);

    this.activeRunId = runId;
    this.cancelController = new AbortController();
    void this.drive(runId, binaries, settings.pathMappings, settings.concurrency);
    return runId;
  }

  /** Marks the run cancelled immediately: currentRun() reports "cancelling"
   *  right away and in-flight ffmpeg/ffprobe processes are killed. */
  cancel(): void {
    // Only meaningful while a run is active: cancelling an idle manager must
    // not override the settled state of the previous run in currentRun().
    if (!this.running) return;
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
      const state = this.failed || this.cancelled ? "cancelled" : "done";
      this.db
        .prepare("UPDATE scan_runs SET state = ?, finished_at = ? WHERE id = ?")
        .run(state, new Date().toISOString(), runId);
      this.cancelController = null;
      this.running = false;
      // The run is settled: drop the flags so currentRun() reports the final
      // DB state instead of an endless in-memory "cancelling".
      this.cancelled = false;
      this.failed = false;
    }
  }

  private async worker(runId: number, ctx: CheckContext): Promise<void> {
    for (;;) {
      if (this.cancelled || this.failed) return;
      const item = this.claim(runId);
      if (!item) return;
      try {
        const file = this.db
          .prepare("SELECT id, path, status FROM media_files WHERE id = ?")
          .get(item.media_file_id) as { id: number; path: string; status: string } | undefined;
        if (!file) {
          this.db.prepare("UPDATE scan_items SET state = 'skipped' WHERE id = ?").run(item.id);
          continue;
        }
        let outcome: CheckOutcome;
        try {
          outcome = await checkMediaFile(file.path, ctx);
        } catch (err) {
          if (this.cancelled || this.failed || ctx.signal?.aborted) {
            // Cancelled or torn down mid-file: the in-flight check was killed
            // on purpose, so leave the item pending instead of persisting a
            // bogus verdict.
            this.db.prepare("UPDATE scan_items SET state = 'pending' WHERE id = ?").run(item.id);
            return;
          }
          outcome = {
            status: "suspect",
            detail: "checker error: " + String((err as Error)?.message ?? err),
            probe: null
          };
        }
        // Close the window between the last in-checker cancellation
        // checkpoint and the verdict write: an abort landing here must not
        // persist a verdict computed from killed processes.
        if (this.cancelled || this.failed || ctx.signal?.aborted) {
          this.db.prepare("UPDATE scan_items SET state = 'pending' WHERE id = ?").run(item.id);
          return;
        }
        const verdict = persistCheckOutcome(this.db, file, outcome);
        if (!verdict.wrote && verdict.reason === "row-changed") {
          // Sync relinked the row to a replacement download (or removed it)
          // while the check ran: the verdict describes the old path, so drop
          // it and leave the fresh file to the next unchecked scan.
          this.db.prepare("UPDATE scan_items SET state = 'skipped' WHERE id = ?").run(item.id);
          continue;
        }
        const done = this.db.prepare("UPDATE scan_items SET state = 'done' WHERE id = ?").run(item.id);
        if (done.changes > 0) {
          // The item can cascade away when sync deletes its media_files row
          // mid-scan; only count progress for work that actually landed. A
          // purged row kept purged did real work but is not resolved: count
          // the issue so the run reports replacements that have not landed.
          const healthy = verdict.wrote && verdict.status === "healthy";
          this.db
            .prepare("UPDATE scan_runs SET done = done + 1, issues = issues + ? WHERE id = ?")
            .run(healthy ? 0 : 1, runId);
        }
      } catch (err) {
        // DB or infrastructure failure: release the item and stop the whole
        // run - surviving workers exit through the aborted signal instead of
        // writing into a run that is already finalized.
        this.failed = true;
        try {
          this.db.prepare("UPDATE scan_items SET state = 'pending' WHERE id = ?").run(item.id);
        } catch {
          /* the db is the thing that just broke */
        }
        try {
          this.cancelController?.abort();
        } catch {
          /* already torn down */
        }
        console.error("scan worker failed:" + NL + String((err as Error)?.stack ?? err));
        return;
      }
    }
  }

  /** Synchronous claim between awaits is race-free in the single-threaded event loop. */
  private claim(runId: number): ClaimedItem | null {
    const item = this.db
      .prepare(
        "SELECT id, media_file_id FROM scan_items WHERE run_id = ? AND state = 'pending' ORDER BY id LIMIT 1"
      )
      .get(runId) as unknown as ClaimedItem | undefined;
    if (!item) return null;
    this.db.prepare("UPDATE scan_items SET state = 'running' WHERE id = ?").run(item.id);
    return item;
  }
}
