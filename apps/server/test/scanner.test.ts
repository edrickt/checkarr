import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

// Binaries are stubbed so start() never spawns ffmpeg.
vi.mock("../src/services/ffmpeg.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/ffmpeg.js")>();
  return { ...actual, binariesUsable: vi.fn(async () => null) };
});

// The checker is replaced with a controllable fake; the abort signal is
// honored exactly like the real checker honors it.
const checkMock = vi.fn();
vi.mock("../src/services/checker.js", () => ({
  checkMediaFile: (...args: unknown[]) => checkMock(...args)
}));

import { migrate, type DB } from "../src/db.js";
import { persistOutcome, resumeInterruptedScans, ScanManager } from "../src/services/scanner.js";
import type { CheckContext, CheckOutcome } from "../src/services/checker.js";

function makeDb(): DB {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function seedFile(db: DB, path = "/movies/a.mkv"): number {
  db.prepare(
    "INSERT INTO sources (type, name, base_url, api_key) VALUES ('radarr', 'R', 'http://127.0.0.1:1', 'k')"
  ).run();
  return Number(
    db
      .prepare(
        "INSERT INTO media_files (source_id, kind, external_id, title, path) VALUES (1, 'movie', '1', 'A', ?)"
      )
      .run(path).lastInsertRowid
  );
}

const healthy: CheckOutcome = { status: "healthy", detail: null, probe: null };

function checkerHonoringSignal(result: CheckOutcome | Error): void {
  checkMock.mockImplementation(
    (_path: string, ctx: CheckContext) =>
      new Promise<CheckOutcome>((resolve, reject) => {
        const t = setTimeout(() => (result instanceof Error ? reject(result) : resolve(result)), 30);
        ctx.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new Error("scan cancelled"));
          },
          { once: true }
        );
      })
  );
}

async function settle(manager: ScanManager, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now();
  while (manager.isActive() && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 30)); // let the finally block land
}

beforeEach(() => {
  checkMock.mockReset();
  checkMock.mockResolvedValue(healthy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ScanManager", () => {
  it("runs a scan to done, persisting verdicts and progress", async () => {
    const db = makeDb();
    const fileId = seedFile(db);
    const m = new ScanManager(db);
    const runId = await m.start("unchecked");
    expect(runId).toBeGreaterThan(0);
    await settle(m);
    expect(m.isActive()).toBe(false);
    const run = db.prepare("SELECT state, total, done, issues FROM scan_runs WHERE id = ?").get(runId) as any;
    expect(run.state).toBe("done");
    expect(run.total).toBe(1);
    expect(run.done).toBe(1);
    expect(run.issues).toBe(0);
    expect((db.prepare("SELECT status FROM media_files WHERE id = ?").get(fileId) as any).status).toBe(
      "healthy"
    );
  });

  it("rejects an overlapping start with 409 (the old async gate allowed two runs)", async () => {
    const db = makeDb();
    seedFile(db);
    const m = new ScanManager(db);
    checkerHonoringSignal(healthy); // keep the first run in flight
    const p1 = m.start("unchecked");
    await expect(m.start("unchecked")).rejects.toThrow(/already running/);
    m.cancel();
    await settle(m);
    await p1;
  });

  it("cancel mid-check leaves the item pending and the run cancelled, persisting nothing", async () => {
    const db = makeDb();
    const fileId = seedFile(db);
    const m = new ScanManager(db);
    checkerHonoringSignal(healthy);
    await m.start("unchecked");
    await new Promise((r) => setTimeout(r, 10)); // worker is inside the check now
    m.cancel();
    await settle(m);
    const item = db.prepare("SELECT state FROM scan_items").get() as any;
    expect(item.state).toBe("pending");
    const run = db.prepare("SELECT state FROM scan_runs").get() as any;
    expect(run.state).toBe("cancelled");
    expect((db.prepare("SELECT status FROM media_files WHERE id = ?").get(fileId) as any).status).toBe(
      "unchecked"
    );
  });

  it("a checker crash marks the file suspect and counts it as an issue", async () => {
    const db = makeDb();
    seedFile(db);
    const m = new ScanManager(db);
    checkMock.mockRejectedValue(new Error("boom"));
    await m.start("unchecked");
    await settle(m);
    const run = db.prepare("SELECT state, issues FROM scan_runs").get() as any;
    expect(run.state).toBe("done");
    expect(run.issues).toBe(1);
    expect((db.prepare("SELECT status FROM media_files").get() as any).status).toBe("suspect");
  });

  it("a worker DB failure stops the run without zombie workers counting progress", async () => {
    const db = makeDb();
    seedFile(db);
    const m = new ScanManager(db);
    checkerHonoringSignal(healthy);
    // Sabotage only the first persistOutcome-shaped write (scan_items done
    // update) by deleting the media row while the check is in flight, and
    // make the scan_runs UPDATE fail via a dropped table? Too invasive:
    // instead force persistOutcome to throw by making media_files read-only
    // is not possible in sqlite pragmatically - so simulate by breaking the
    // db connection mid-flight.
    let broke = false;
    const origPrepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      if (!broke && sql.includes("UPDATE scan_items SET state = 'done'")) {
        broke = true;
        throw new Error("SQLITE_BUSY: simulated lock failure");
      }
      return origPrepare(sql);
    };
    await m.start("unchecked");
    await settle(m);
    const run = db.prepare("SELECT state FROM scan_runs").get() as any;
    expect(run.state).toBe("cancelled"); // failed runs finalize as cancelled
    expect(m.isActive()).toBe(false);
    const item = db.prepare("SELECT state FROM scan_items").get() as any;
    expect(["pending", "done"]).toContain(item.state);
  });

  it("done never exceeds total when the claimed row cascades away mid-check", async () => {
    const db = makeDb();
    const fileId = seedFile(db);
    const m = new ScanManager(db);
    checkMock.mockImplementation(async () => {
      db.prepare("DELETE FROM media_files WHERE id = ?").run(fileId); // sync-style cascade
      return healthy;
    });
    await m.start("unchecked");
    await settle(m);
    const run = db.prepare("SELECT state, total, done FROM scan_runs").get() as any;
    expect(run.state).toBe("done");
    expect(run.total).toBe(1);
    expect(run.done).toBe(0); // the cascaded item must not count
  });

  it("cancel() while idle is a no-op that preserves the last run's state", async () => {
    const db = makeDb();
    seedFile(db);
    const m = new ScanManager(db);
    await m.start("unchecked");
    await settle(m);
    const before = db.prepare("SELECT state FROM scan_runs").get() as any;
    m.cancel();
    const cur = m.currentRun() as any;
    expect(cur.state).toBe(before.state); // not stuck on "cancelling"
  });
});

describe("resumeInterruptedScans", () => {
  it("resets orphaned running items and marks stale runs cancelled", () => {
    const db = makeDb();
    const fileId = seedFile(db);
    const runId = Number(
      db
        .prepare(
          "INSERT INTO scan_runs (mode, scope, state, total, started_at) VALUES ('quick', 'unchecked', 'running', 1, '2026-01-01')"
        )
        .run().lastInsertRowid
    );
    db.prepare("INSERT INTO scan_items (run_id, media_file_id, state) VALUES (?, ?, 'running')").run(
      runId,
      fileId
    );
    resumeInterruptedScans(db);
    expect((db.prepare("SELECT state FROM scan_items").get() as any).state).toBe("pending");
    expect((db.prepare("SELECT state FROM scan_runs").get() as any).state).toBe("cancelled");
  });
});

describe("persistOutcome", () => {
  it("writes verdict, probe fields and probe_json exactly", () => {
    const db = makeDb();
    const fileId = seedFile(db);
    persistOutcome(db, fileId, {
      status: "corrupt",
      detail: "start (first 10s) failed (exit 1):Invalid data",
      probe: { durationS: 12.5, container: "matroska,webm", videoCodec: "h264", audioCodec: "aac" }
    });
    const row = db
      .prepare(
        "SELECT status, error_detail, duration_s, container, video_codec, audio_codec, probe_json, checked_at FROM media_files WHERE id = ?"
      )
      .get(fileId) as any;
    expect(row.status).toBe("corrupt");
    expect(row.error_detail).toContain("Invalid data");
    expect(row.duration_s).toBe(12.5);
    expect(row.container).toBe("matroska,webm");
    expect(row.video_codec).toBe("h264");
    expect(row.audio_codec).toBe("aac");
    expect(JSON.parse(row.probe_json)).toEqual({
      durationS: 12.5,
      container: "matroska,webm",
      videoCodec: "h264",
      audioCodec: "aac"
    });
    expect(row.checked_at).toBeTruthy();
    const probeless = persistOutcomeProbeNull(db, fileId);
    expect(probeless).toBeUndefined();
  });
});

function persistOutcomeProbeNull(db: DB, fileId: number): void {
  persistOutcome(db, fileId, { status: "missing", detail: "File not found", probe: null });
  const row = db
    .prepare("SELECT status, probe_json, duration_s FROM media_files WHERE id = ?")
    .get(fileId) as any;
  expect(row.probe_json).toBeNull();
  expect(row.duration_s).toBeNull();
}
