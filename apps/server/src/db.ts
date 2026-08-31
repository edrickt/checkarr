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
    " updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
  "INSERT OR IGNORE INTO settings (id) VALUES (1)",
  // installs that never touched the old default of 2 get bumped to 8; deliberate values stay put
  "UPDATE settings SET concurrency = 8 WHERE id = 1 AND concurrency = 2",
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
    " UNIQUE (source_id, path))",
  "CREATE INDEX IF NOT EXISTS idx_media_files_status ON media_files(status)",
  "CREATE INDEX IF NOT EXISTS idx_media_files_source ON media_files(source_id)",
  "CREATE TABLE IF NOT EXISTS scan_runs (" +
    " id INTEGER PRIMARY KEY AUTOINCREMENT," +
    " mode TEXT NOT NULL CHECK (mode IN ('quick'))," +
    " scope TEXT NOT NULL DEFAULT 'unchecked' CHECK (scope IN ('unchecked','all'))," +
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
  "CREATE INDEX IF NOT EXISTS idx_scan_items_run ON scan_items(run_id, state)"
];

export function migrate(db: DB): void {
  for (const stmt of SCHEMA) db.exec(stmt);
}

export function openDb(): DB {
  ensureDataDir();
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}
