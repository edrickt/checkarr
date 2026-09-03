import { DatabaseSync } from "node:sqlite";
import { DB_PATH, ensureDataDir } from "./config.js";

export type DB = DatabaseSync;

// One SQL statement per array entry, executed in order.
const SCHEMA: string[] = [
  "CREATE TABLE IF NOT EXISTS settings (" +
    " id INTEGER PRIMARY KEY CHECK (id = 1)," +
    " concurrency INTEGER NOT NULL DEFAULT 8," +
    " ffmpeg_path TEXT," +
    " ffprobe_path TEXT," +
    " path_mappings TEXT NOT NULL DEFAULT '[]'," +
    " local_broadcast INTEGER NOT NULL DEFAULT 0," +
    " updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "INSERT OR IGNORE INTO settings (id) VALUES (1)",
  "CREATE TABLE IF NOT EXISTS sources (" +
    " id INTEGER PRIMARY KEY AUTOINCREMENT," +
    " type TEXT NOT NULL CHECK (type IN ('radarr','sonarr'))," +
    " name TEXT NOT NULL," +
    " base_url TEXT NOT NULL," +
    " api_key TEXT NOT NULL," +
    " enabled INTEGER NOT NULL DEFAULT 1," +
    " last_sync_at TEXT," +
    " last_sync_error TEXT," +
    " created_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS media_files (" +
    " id INTEGER PRIMARY KEY AUTOINCREMENT," +
    " source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE," +
    " kind TEXT NOT NULL CHECK (kind IN ('movie','episode'))," +
    " external_id TEXT NOT NULL," +
    " title TEXT NOT NULL," +
    " subtitle TEXT," +
    " path TEXT," +
    " size_bytes INTEGER," +
    " quality TEXT," +
    " status TEXT NOT NULL DEFAULT 'unchecked' CHECK (status IN" +
    " ('unchecked','healthy','suspect','corrupt','missing','unreachable','purged'))," +
    " duration_s REAL," +
    " container TEXT," +
    " video_codec TEXT," +
    " audio_codec TEXT," +
    " error_detail TEXT," +
    " probe_json TEXT," +
    " checked_at TEXT," +
    " created_at TEXT NOT NULL DEFAULT (datetime('now'))," +
    " updated_at TEXT NOT NULL DEFAULT (datetime('now'))," +
    " UNIQUE (source_id, path))",
  "CREATE INDEX IF NOT EXISTS idx_media_files_status ON media_files(status)",
  "CREATE INDEX IF NOT EXISTS idx_media_files_source ON media_files(source_id)",
  "CREATE TABLE IF NOT EXISTS scan_runs (" +
    " id INTEGER PRIMARY KEY AUTOINCREMENT," +
    " mode TEXT NOT NULL CHECK (mode IN ('quick'))," +
    " scope TEXT NOT NULL DEFAULT 'unchecked' CHECK (scope IN" +
    " ('unchecked','corrupt','suspect','missing','unreachable','purged','all'))," +
    " source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL," +
    " state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','done','cancelled'))," +
    " total INTEGER NOT NULL DEFAULT 0," +
    " done INTEGER NOT NULL DEFAULT 0," +
    " issues INTEGER NOT NULL DEFAULT 0," +
    " started_at TEXT NOT NULL DEFAULT (datetime('now'))," +
    " finished_at TEXT)",
  "CREATE TABLE IF NOT EXISTS scan_items (" +
    " id INTEGER PRIMARY KEY AUTOINCREMENT," +
    " run_id INTEGER NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE," +
    " media_file_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE," +
    " state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','skipped'))," +
    " UNIQUE (run_id, media_file_id))",
  "CREATE INDEX IF NOT EXISTS idx_scan_items_run ON scan_items(run_id, state)",
  // Reclassify legacy probe-path "corrupt" rows: only findings containing
  // "invalid data found when processing input" are corrupt; timeouts and
  // other probe failures are suspect. Idempotent - matches nothing once run.
  "UPDATE media_files SET status = 'suspect', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')" +
    " WHERE status = 'corrupt' AND error_detail LIKE 'probe: container could not be parsed%'" +
    " AND instr(lower(error_detail), 'invalid data found when processing input') = 0"
];

export function migrate(db: DB): void {
  for (const stmt of SCHEMA) db.exec(stmt);
  // Local broadcasting (bind 0.0.0.0 instead of loopback) is a per-install
  // setting: older DBs need the column added (no-op if already there).
  const settingsCols = db.prepare("PRAGMA table_info(settings)").all() as { name: string }[];
  if (!settingsCols.some((c) => c.name === "local_broadcast")) {
    db.exec("ALTER TABLE settings ADD COLUMN local_broadcast INTEGER NOT NULL DEFAULT 0");
  }
  // Per-library scans: scan_runs.source_id ships in the CREATE TABLE above for
  // fresh installs; older DBs need the column added (no-op if already there).
  const cols = db.prepare("PRAGMA table_info(scan_runs)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "source_id")) {
    db.exec("ALTER TABLE scan_runs ADD COLUMN source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL");
  }
  // Older installs lock scan_runs.scope to a CHECK without 'purged' (the
  // first generation even lacked corrupt..unreachable); widen it with the
  // standard table-rebuild recipe (foreign keys off, copy rows, swap
  // tables). Idempotent: skips once widened.
  const scanRunsSql =
    (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scan_runs'").get() as
        { sql: string } | undefined
    )?.sql ?? "";
  if (scanRunsSql.length > 0 && !scanRunsSql.includes("'purged'")) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      db.exec(
        "CREATE TABLE scan_runs_new (" +
          " id INTEGER PRIMARY KEY AUTOINCREMENT," +
          " mode TEXT NOT NULL CHECK (mode IN ('quick'))," +
          " scope TEXT NOT NULL DEFAULT 'unchecked' CHECK (scope IN" +
          " ('unchecked','corrupt','suspect','missing','unreachable','purged','all'))," +
          " source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL," +
          " state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','done','cancelled'))," +
          " total INTEGER NOT NULL DEFAULT 0," +
          " done INTEGER NOT NULL DEFAULT 0," +
          " issues INTEGER NOT NULL DEFAULT 0," +
          " started_at TEXT NOT NULL DEFAULT (datetime('now'))," +
          " finished_at TEXT)"
      );
      db.exec(
        "INSERT INTO scan_runs_new (id, mode, scope, source_id, state, total, done, issues, started_at, finished_at)" +
          " SELECT id, mode, scope, source_id, state, total, done, issues, started_at, finished_at FROM scan_runs"
      );
      db.exec("DROP TABLE scan_runs");
      db.exec("ALTER TABLE scan_runs_new RENAME TO scan_runs");
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* nothing to roll back */
      }
      db.exec("PRAGMA foreign_keys = ON");
      throw err;
    }
    db.exec("PRAGMA foreign_keys = ON");
  }

  // Purged ("Delete & re-search") files get their own status 'purged':
  // older installs lock media_files.status to a CHECK without it. Also
  // rebuild when path is still NOT NULL: monitored items without a file at
  // the *arr (not downloaded yet) are tracked as missing rows with a NULL
  // path. Rebuild with the standard table-rebuild recipe (foreign keys off,
  // copy rows, swap tables). An intermediate build called the status
  // 're-searched' - those rows are renamed during the copy. Idempotent:
  // skips once both are in place.
  const mediaFilesSql =
    (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_files'").get() as
        { sql: string } | undefined
    )?.sql ?? "";
  if (
    mediaFilesSql.length > 0 &&
    (!mediaFilesSql.includes("'purged'") || mediaFilesSql.includes("path TEXT NOT NULL"))
  ) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      db.exec(
        "CREATE TABLE media_files_new (" +
          " id INTEGER PRIMARY KEY AUTOINCREMENT," +
          " source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE," +
          " kind TEXT NOT NULL CHECK (kind IN ('movie','episode'))," +
          " external_id TEXT NOT NULL," +
          " title TEXT NOT NULL," +
          " subtitle TEXT," +
          " path TEXT," +
          " size_bytes INTEGER," +
          " quality TEXT," +
          " status TEXT NOT NULL DEFAULT 'unchecked' CHECK (status IN" +
          " ('unchecked','healthy','suspect','corrupt','missing','unreachable','purged'))," +
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
        "INSERT INTO media_files_new (id, source_id, kind, external_id, title, subtitle, path, size_bytes," +
          " quality, status, duration_s, container, video_codec, audio_codec, error_detail, probe_json," +
          " checked_at, created_at, updated_at)" +
          " SELECT id, source_id, kind, external_id, title, subtitle, path, size_bytes, quality," +
          " CASE WHEN status = 're-searched' THEN 'purged' ELSE status END," +
          " duration_s, container, video_codec, audio_codec, error_detail, probe_json, checked_at," +
          " created_at, updated_at FROM media_files"
      );
      db.exec("DROP TABLE media_files");
      db.exec("ALTER TABLE media_files_new RENAME TO media_files");
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* nothing to roll back */
      }
      db.exec("PRAGMA foreign_keys = ON");
      throw err;
    }
    // The rebuild dropped the table's indexes (SCHEMA created them before
    // this migration could run); put them back.
    db.exec("CREATE INDEX IF NOT EXISTS idx_media_files_status ON media_files(status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_media_files_source ON media_files(source_id)");
    db.exec("PRAGMA foreign_keys = ON");
  }
}

export function openDb(): DB {
  ensureDataDir();
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  // A stray sqlite3 CLI / backup job holding a write lock should make us wait,
  // not crash a worker mid-scan with SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}
