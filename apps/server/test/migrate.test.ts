import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db.js";

// A database created by an older install: scan_runs.scope is locked to
// ('unchecked','all') by a CHECK constraint.
function makeOldDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(
    "CREATE TABLE settings (" +
      " id INTEGER PRIMARY KEY CHECK (id = 1)," +
      " concurrency INTEGER NOT NULL DEFAULT 8," +
      " ffmpeg_path TEXT," +
      " ffprobe_path TEXT," +
      " path_mappings TEXT NOT NULL DEFAULT '[]'," +
      " updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
  );
  db.exec(
    "CREATE TABLE sources (" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT," +
      " type TEXT NOT NULL CHECK (type IN ('radarr','sonarr'))," +
      " name TEXT NOT NULL," +
      " base_url TEXT NOT NULL," +
      " api_key TEXT NOT NULL," +
      " enabled INTEGER NOT NULL DEFAULT 1," +
      " last_sync_at TEXT," +
      " last_sync_error TEXT," +
      " created_at TEXT NOT NULL DEFAULT (datetime('now')))"
  );
  db.exec(
    "CREATE TABLE media_files (" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT," +
      " source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE," +
      " kind TEXT NOT NULL CHECK (kind IN ('movie','episode'))," +
      " external_id TEXT NOT NULL," +
      " title TEXT NOT NULL," +
      " subtitle TEXT," +
      " path TEXT NOT NULL," +
      " size_bytes INTEGER," +
      " quality TEXT," +
      " status TEXT NOT NULL DEFAULT 'unchecked' CHECK (status IN" +
      " ('unchecked','healthy','suspect','corrupt','missing','unreachable'))," +
      " duration_s REAL," +
      " container TEXT," +
      " video_codec TEXT," +
      " audio_codec TEXT," +
      " error_detail TEXT," +
      " probe_json TEXT," +
      " checked_at TEXT," +
      " created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
      " updated_at TEXT NOT NULL DEFAULT (datetime('now'))," +
      " UNIQUE (source_id, path))"
  );
  db.exec(
    "CREATE TABLE scan_runs (" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT," +
      " mode TEXT NOT NULL CHECK (mode IN ('quick'))," +
      " scope TEXT NOT NULL DEFAULT 'unchecked' CHECK (scope IN ('unchecked','all'))," +
      " source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL," +
      " state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','done','cancelled'))," +
      " total INTEGER NOT NULL DEFAULT 0," +
      " done INTEGER NOT NULL DEFAULT 0," +
      " issues INTEGER NOT NULL DEFAULT 0," +
      " started_at TEXT NOT NULL DEFAULT (datetime('now'))," +
      " finished_at TEXT)"
  );
  db.exec(
    "CREATE TABLE scan_items (" +
      " id INTEGER PRIMARY KEY AUTOINCREMENT," +
      " run_id INTEGER NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE," +
      " media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE," +
      " state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','skipped'))," +
      " UNIQUE (run_id, media_file_id))"
  );
  return db;
}

describe("migrate", () => {
  it("widens the scan_runs.scope CHECK on old databases, preserving rows", () => {
    const db = makeOldDb();
    db.prepare(
      "INSERT INTO sources (id, type, name, base_url, api_key) VALUES (1, 'radarr', 'R', '', 'k')"
    ).run();
    db.prepare(
      "INSERT INTO media_files (id, source_id, kind, external_id, title, path) VALUES (1, 1, 'movie', '1', 'A', '/movies/a.mkv')"
    ).run();
    const oldRun = db
      .prepare(
        "INSERT INTO scan_runs (mode, scope, state, total, done, issues) VALUES ('quick', 'unchecked', 'done', 1, 1, 0)"
      )
      .run();
    const oldRunId = Number(oldRun.lastInsertRowid);
    db.prepare("INSERT INTO scan_items (run_id, media_file_id, state) VALUES (?, 1, 'done')").run(oldRunId);

    migrate(db);

    // Old rows survived the rebuild, children intact.
    const run = db
      .prepare("SELECT id, mode, scope, state, total FROM scan_runs WHERE id = ?")
      .get(oldRunId) as any;
    expect(run).toEqual({ id: oldRunId, mode: "quick", scope: "unchecked", state: "done", total: 1 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM scan_items").get() as any).n).toBe(1);

    // New scopes insert cleanly on the migrated table.
    db.prepare(
      "INSERT INTO scan_runs (mode, scope, state, total) VALUES ('quick', 'corrupt', 'running', 0)"
    ).run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM scan_runs").get() as any).n).toBe(2);
  });
});
