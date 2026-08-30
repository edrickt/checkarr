import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { migrate, type DB } from "../src/db.js";
import { syncSource } from "../src/services/sync.js";

function makeDb(): DB {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function insertSource(db: DB, type: string, baseUrl: string, apiKey: string): { id: number; type: string; name: string; base_url: string; api_key: string } {
  db.prepare("INSERT INTO sources (type, name, base_url, api_key) VALUES (?, 'test', ?, ?)").run(type, baseUrl, apiKey);
  return db.prepare("SELECT id, type, name, base_url, api_key FROM sources WHERE id = 1").get() as {
    id: number; type: string; name: string; base_url: string; api_key: string;
  };
}

const MOVIES = [
  { id: 1, title: "Alpha", year: 2020, movieFile: { path: "/movies/alpha.mkv", size: 123, quality: { quality: { name: "WEBDL-1080p" } } } },
  { id: 2, title: "No File Yet", year: 2021, movieFile: null }
];

const SERIES = [{ id: 7, title: "Beta Show" }];

const EPISODES = [
  { id: 11, seriesId: 7, seasonNumber: 1, episodeNumber: 2, title: "Pilot", hasFile: true, episodeFile: { path: "/tv/beta/s01e02.mkv", size: 456, quality: { quality: { name: "HDTV-720p" } } } },
  { id: 12, seriesId: 7, seasonNumber: 1, episodeNumber: 3, title: "Two", hasFile: true, episodeFile: { path: "/tv/beta/s01e03.mkv", size: 789, quality: { quality: { name: "HDTV-720p" } } } },
  { id: 13, seriesId: 7, seasonNumber: 1, episodeNumber: 4, title: "Missing", hasFile: false, episodeFile: null }
];

describe("sync", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.headers["x-api-key"] !== "good-key") {
        res.writeHead(401, { "content-type": "application/json" }).end("{}");
        return;
      }
      const json = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      const u = new URL(req.url ?? "/", "http://localhost");
      if (u.pathname === "/api/v3/movie") return json(MOVIES);
      if (u.pathname === "/api/v3/series") return json(SERIES);
      // Real Sonarr rejects bare /episode calls with HTTP 400 and only embeds
      // episodeFile when includeEpisodeFile=true. Mimic both so a regression here fails loudly.
      if (u.pathname === "/api/v3/episode") {
        const sid = u.searchParams.get("seriesId");
        if (!sid) {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ message: "seriesId or episodeIds must be provided" }));
          return;
        }
        const includeFile = u.searchParams.get("includeEpisodeFile") === "true";
        return json(
          EPISODES
            .filter((e) => String(e.seriesId) === sid)
            .map((e) => (includeFile ? e : { ...e, episodeFile: null }))
        );
      }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    url = "http://127.0.0.1:" + addr.port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("radarr: adds only files, upserts on re-sync", async () => {
    const db = makeDb();
    const src = insertSource(db, "radarr", url, "good-key");
    const first = await syncSource(db, src);
    expect(first.added).toBe(1);
    expect(first.updated).toBe(0);
    const rows = db.prepare("SELECT path, quality, kind FROM media_files").all() as { path: string; quality: string; kind: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].path).toBe("/movies/alpha.mkv");
    expect(rows[0].quality).toBe("WEBDL-1080p");
    expect(rows[0].kind).toBe("movie");

    const second = await syncSource(db, src);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.removed).toBe(0);
  });

  it("sonarr: creates episode rows with season/episode subtitles", async () => {
    const db = makeDb();
    const src = insertSource(db, "sonarr", url, "good-key");
    const r = await syncSource(db, src);
    expect(r.added).toBe(2);
    const rows = db.prepare("SELECT title, subtitle, path FROM media_files ORDER BY path").all() as { title: string; subtitle: string; path: string }[];
    expect(rows.length).toBe(2);
    expect(rows[0].title).toBe("Beta Show");
    expect(rows[0].subtitle).toContain("S01E02");
    expect(rows[0].subtitle).toContain("Pilot");
    expect(rows[1].subtitle).toContain("S01E03");
  });

  it("removes rows for files no longer in the library", async () => {
    const db = makeDb();
    const src = insertSource(db, "sonarr", url, "good-key");
    await syncSource(db, src);
    db.prepare("INSERT INTO media_files (source_id, kind, external_id, title, path) VALUES (1, 'episode', '99', 'Stale', '/tv/beta/stale.mkv')").run();
    const r = await syncSource(db, src);
    expect(r.removed).toBe(1);
    const stale = db.prepare("SELECT id FROM media_files WHERE path = '/tv/beta/stale.mkv'").get();
    expect(stale).toBeUndefined();
  });

  it("preserves verdicts across re-syncs", async () => {
    const db = makeDb();
    const src = insertSource(db, "radarr", url, "good-key");
    await syncSource(db, src);
    db.prepare("UPDATE media_files SET status = 'corrupt', error_detail = 'x' WHERE id = 1").run();
    await syncSource(db, src);
    const row = db.prepare("SELECT status FROM media_files WHERE id = 1").get() as { status: string };
    expect(row.status).toBe("corrupt");
  });

  it("surfaces auth failures with a clear message", async () => {
    const db = makeDb();
    const src = insertSource(db, "radarr", url, "wrong-key");
    await expect(syncSource(db, src)).rejects.toThrow(/Unauthorized/);
    const srow = db.prepare("SELECT last_sync_error FROM sources WHERE id = 1").get() as { last_sync_error: string | null };
    expect(srow.last_sync_error).toBeNull(); // syncSource rethrows; caller records the error
  });
});
