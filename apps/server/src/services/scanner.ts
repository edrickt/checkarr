import os from "node:os";
import type { DB } from "../db.js";
import { getSettings, type PathMapping } from "../settings.js";
import { binariesUsable, resolveBinaries, type Binaries } from "./ffmpeg.js";
import { checkMediaFile, type CheckContext, type CheckOutcome, type ScanMode } from "./checker.js";
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
        "SELECT id, mode, scope, state, total, done, issues, started_at AS startedAt, finished_at AS finishedAt" +
          " FROM scan_runs WHERE id = ?"
      )
      .get(this.activeRunId);
    return (row as Record<string, unknown>) ?? null;
  }

  async start(mode: ScanMode, scope: "unchecked" | "all"): Promise<number> {
    if (this.running) throw new ApiError(409, "A scan is already running");
    const settings = getSettings(this.db);
    const binaries = resolveBinaries(settings);
    const problem = await binariesUsable(binaries);
    if (problem) throw new ApiError(400, problem);

    const rows = (scope === "all"
      ? this.db.prepare("SELECT id FROM media_files ORDER BY id").all()
      : this.db.prepare("SELECT id FROM media_files WHERE status = 'unchecked' ORDER BY id").all()) as { id: number }[];
    if (rows.length === 0) throw new ApiError(400, "No files match the scan scope");

    const runRes = this.db
      .prepare("INSERT INTO scan_runs (mode, scope, state, total, started_at) VALUES (?, ?, 'running', ?, ?)")
      .run(mode, scope, rows.length, new Date().toISOString());
    const runId = Number(runRes.lastInsertRowid);
    const insItem = this.db.prepare("INSERT OR IGNORE INTO scan_items (run_id, media_file_id) VALUES (?, ?)");
    for (const r of rows) insItem.run(runId, r.id);

    this.running = true;
    this.cancelled = false;
    this.activeRunId = runId;
    void this.drive(runId, mode, binaries, settings.pathMappings, settings.concurrency);
    return runId;
  }

  cancel(): void {
    if (this.running) this.cancelled = true;
  }

  private async drive(
    runId: number,
    mode: ScanMode,
    binaries: Binaries,
    mappings: PathMapping[],
    concurrency: number
  ): Promise<void> {
    try {
      const n = Math.min(32, Math.max(1, concurrency));
      // Spread the box's logical cores across workers so ffmpeg never takes
      // the whole machine: e.g. 8 workers on 8 cores = 1 decode thread each,
      // 2 workers on 8 cores = 4 threads each. Decode threads also drive
      // memory (frame buffers), so this caps RAM per process too.
      const threads = Math.max(1, Math.min(8, Math.floor(os.cpus().length / n)));
      const ctx: CheckContext = { binaries, mappings, mode, threads };
      const workers: Promise<void>[] = [];
      for (let i = 0; i < n; i++) workers.push(this.worker(runId, ctx));
      await Promise.all(workers);
    } catch (err) {
      console.error("scan run " + runId + " crashed:" + NL + String((err as Error)?.stack ?? err));
    } finally {
      const state = this.cancelled ? "cancelled" : "done";
      this.db.prepare("UPDATE scan_runs SET state = ?, finished_at = ? WHERE id = ?").run(state, new Date().toISOString(), runId);
      this.running = false;
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
