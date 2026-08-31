import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { migrate, type DB } from "../src/db.js";
import { syncOneItem, syncSource } from "../src/services/sync.js";

function makeDb(): DB {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function insertSource(
  db: DB,
  type: string,
  baseUrl: string,
  apiKey: string
): { id: number; type: string; name: string; base_url: string; api_key: string } {
  db.prepare("INSERT INTO sources (type, name, base_url, api_key) VALUES (?, 'test', ?, ?)").run(
    type,
    baseUrl,
    apiKey
  );
  return db.prepare("SELECT id, type, name, base_url, api_key FROM sources WHERE id = 1").get() as {
    id: number;
    type: string;
    name: string;
    base_url: string;
    api_key: string;
  };
}

interface FixtureFile {
  path: string;
  size: number;
  quality: { quality: { name: string } };
}

interface MovieFixture {
  id: number;
  title: string;
  year: number;
  monitored?: boolean;
  movieFile: FixtureFile | null;
}

const MOVIES: MovieFixture[] = [
  {
    id: 1,
    title: "Alpha",
    year: 2020,
    monitored: true,
    movieFile: { path: "/movies/alpha.mkv", size: 123, quality: { quality: { name: "WEBDL-1080p" } } }
  },
  // Unmonitored with no file: the *arr does not consider it part of the
  // library, so neither do we (tests below flip the flag to exercise both).
  { id: 2, title: "No File Yet", year: 2021, monitored: false, movieFile: null }
];

const SERIES = [{ id: 7, title: "Beta Show" }];

interface EpisodeFixture {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  monitored?: boolean;
  hasFile: boolean;
  episodeFile: FixtureFile | null;
}

const EPISODES: EpisodeFixture[] = [
  {
    id: 11,
    seriesId: 7,
    seasonNumber: 1,
    episodeNumber: 2,
    title: "Pilot",
    monitored: true,
    hasFile: true,
    episodeFile: { path: "/tv/beta/s01e02.mkv", size: 456, quality: { quality: { name: "HDTV-720p" } } }
  },
  {
    id: 12,
    seriesId: 7,
    seasonNumber: 1,
    episodeNumber: 3,
    title: "Two",
    monitored: true,
    hasFile: true,
    episodeFile: { path: "/tv/beta/s01e03.mkv", size: 789, quality: { quality: { name: "HDTV-720p" } } }
  },
  {
    id: 13,
    seriesId: 7,
    seasonNumber: 1,
    episodeNumber: 4,
    title: "Missing",
    monitored: false,
    hasFile: false,
    episodeFile: null
  }
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
      const json = (body: unknown) =>
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      const u = new URL(req.url ?? "/", "http://localhost");
      if (u.pathname === "/api/v3/movie") return json(MOVIES);
      if (u.pathname === "/api/v3/series") return json(SERIES);
      // Real Sonarr rejects bare /episode calls with HTTP 400 and only embeds
      // episodeFile when includeEpisodeFile=true. Mimic both so a regression here fails loudly.
      if (u.pathname === "/api/v3/episode") {
        const sid = u.searchParams.get("seriesId");
        if (!sid) {
          res
            .writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ message: "seriesId or episodeIds must be provided" }));
          return;
        }
        const includeFile = u.searchParams.get("includeEpisodeFile") === "true";
        return json(
          EPISODES.filter((e) => String(e.seriesId) === sid).map((e) =>
            includeFile ? e : { ...e, episodeFile: null }
          )
        );
      }
      // Single-item fetches used by syncOneItem.
      const oneMovie = /^\/api\/v3\/movie\/(\d+)$/.exec(u.pathname);
      if (oneMovie) {
        const m = MOVIES.find((mv) => String(mv.id) === oneMovie[1]);
        return m ? json(m) : res.writeHead(404).end("{}");
      }
      const oneSeries = /^\/api\/v3\/series\/(\d+)$/.exec(u.pathname);
      if (oneSeries) {
        const s = SERIES.find((sv) => String(sv.id) === oneSeries[1]);
        return s ? json(s) : res.writeHead(404).end("{}");
      }
      const oneEpisode = /^\/api\/v3\/episode\/(\d+)$/.exec(u.pathname);
      if (oneEpisode) {
        const e = EPISODES.find((ep) => String(ep.id) === oneEpisode[1]);
        if (!e) return res.writeHead(404).end("{}");
        const includeFile = u.searchParams.get("includeEpisodeFile") === "true";
        return json(includeFile ? e : { ...e, episodeFile: null });
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
    const rows = db.prepare("SELECT path, quality, kind FROM media_files").all() as {
      path: string;
      quality: string;
      kind: string;
    }[];
    expect(rows.length).toBe(1);
    expect(rows[0].path).toBe("/movies/alpha.mkv");
    expect(rows[0].quality).toBe("WEBDL-1080p");
    expect(rows[0].kind).toBe("movie");

    const second = await syncSource(db, src);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.relinked).toBe(0);
    expect(second.removed).toBe(0);
  });

  it("sonarr: creates episode rows with season/episode subtitles", async () => {
    const db = makeDb();
    const src = insertSource(db, "sonarr", url, "good-key");
    const r = await syncSource(db, src);
    expect(r.added).toBe(2);
    const rows = db.prepare("SELECT title, subtitle, path FROM media_files ORDER BY path").all() as {
      title: string;
      subtitle: string;
      path: string;
    }[];
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
    db.prepare(
      "INSERT INTO media_files (source_id, kind, external_id, title, path) VALUES (1, 'episode', '99', 'Stale', '/tv/beta/stale.mkv')"
    ).run();
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

  it("relinks a purged row when the replacement download lands under a different filename", async () => {
    const db = makeDb();
    const src = insertSource(db, "radarr", url, "good-key");
    await syncSource(db, src);
    // Delete & re-search: the row is purged and the file is gone. Radarr then
    // re-downloads into the same movie folder, but the new release carries
    // different tags, so the filename - and with it the tracked path - differs.
    db.prepare(
      "UPDATE media_files SET status = 'purged', error_detail = 'old verdict', checked_at = '2026-01-01T00:00:00.000Z', probe_json = '{}'"
    ).run();
    const original = MOVIES[0].movieFile;
    MOVIES[0].movieFile = {
      path: "/movies/Braveheart (1995) [WEBDL-1080p][PROPER][repack].mkv",
      size: 4242,
      quality: { quality: { name: "WEBDL-1080p" } }
    };
    try {
      const r = await syncSource(db, src);
      expect(r.added).toBe(0);
      expect(r.relinked).toBe(1);
      expect(r.updated).toBe(0);
      expect(r.removed).toBe(0);
      const row = db
        .prepare(
          "SELECT id, path, status, size_bytes, quality, error_detail, checked_at, probe_json FROM media_files"
        )
        .get() as Record<string, unknown>;
      expect(row.id).toBe(1); // the row survives the swap instead of drop + re-add
      expect(row.path).toBe("/movies/Braveheart (1995) [WEBDL-1080p][PROPER][repack].mkv");
      expect(row.status).toBe("unchecked"); // fresh file, old verdict voided
      expect(row.size_bytes).toBe(4242);
      expect(row.error_detail).toBeNull();
      expect(row.checked_at).toBeNull();
      expect(row.probe_json).toBeNull();
    } finally {
      MOVIES[0].movieFile = original;
    }
  });

  it("relinks episode rows too (sonarr)", async () => {
    const db = makeDb();
    const src = insertSource(db, "sonarr", url, "good-key");
    await syncSource(db, src);
    db.prepare("UPDATE media_files SET status = 'missing' WHERE external_id = '11'").run();
    const original = EPISODES[0].episodeFile;
    EPISODES[0].episodeFile = {
      path: "/tv/beta/S01E02 - Pilot [HDTV-720p][x265][repack].mkv",
      size: 1111,
      quality: { quality: { name: "HDTV-720p" } }
    };
    try {
      const r = await syncSource(db, src);
      expect(r.relinked).toBe(1);
      expect(r.added).toBe(0);
      expect(r.removed).toBe(0);
      const row = db.prepare("SELECT path, status FROM media_files WHERE external_id = '11'").get() as {
        path: string;
        status: string;
      };
      expect(row.path).toBe("/tv/beta/S01E02 - Pilot [HDTV-720p][x265][repack].mkv");
      expect(row.status).toBe("unchecked");
    } finally {
      EPISODES[0].episodeFile = original;
    }
  });

  it("does not relink across external ids: new id + new path means add and remove", async () => {
    const db = makeDb();
    const src = insertSource(db, "radarr", url, "good-key");
    await syncSource(db, src);
    const original = { id: MOVIES[0].id, movieFile: MOVIES[0].movieFile };
    MOVIES[0].id = 42;
    MOVIES[0].movieFile = {
      path: "/movies/alpha-remux.mkv",
      size: 5,
      quality: { quality: { name: "Blu-ray-2160p" } }
    };
    try {
      const r = await syncSource(db, src);
      expect(r.relinked).toBe(0);
      expect(r.added).toBe(1);
      expect(r.removed).toBe(1);
      const rows = db.prepare("SELECT external_id, path FROM media_files").all() as {
        external_id: string;
        path: string;
      }[];
      expect(rows).toEqual([{ external_id: "42", path: "/movies/alpha-remux.mkv" }]);
    } finally {
      MOVIES[0].id = original.id;
      MOVIES[0].movieFile = original.movieFile;
    }
  });

  it("tracks monitored movies without files as missing, then relinks when the file lands", async () => {
    const db = makeDb();
    const src = insertSource(db, "radarr", url, "good-key");
    await syncSource(db, src);
    // The movie's file disappears at the *arr (deleted, not yet replaced) and
    // a second monitored movie is added but not downloaded: both must show up
    // as missing instead of vanishing from the library.
    const original = MOVIES[0].movieFile;
    MOVIES[0].movieFile = null;
    MOVIES.push({ id: 9, title: "Not Yet", year: 2026, monitored: true, movieFile: null });
    try {
      const r = await syncSource(db, src);
      expect(r.added).toBe(1); // id 9: new fileless row
      expect(r.updated).toBe(1); // id 1: parked as missing
      expect(r.removed).toBe(0);
      const rows = db
        .prepare("SELECT external_id, path, status, size_bytes FROM media_files ORDER BY external_id")
        .all();
      expect(rows).toEqual([
        { external_id: "1", path: null, status: "missing", size_bytes: null },
        { external_id: "9", path: null, status: "missing", size_bytes: null }
      ]);
    } finally {
      MOVIES[0].movieFile = original;
      MOVIES.pop();
    }
    // The replacement lands under a new filename: the row relinks to it and
    // the never-downloaded one is dropped now that the *arr forgot it.
    MOVIES[0].movieFile = {
      path: "/movies/Alpha (2020) [WEBDL-1080p][PROPER].mkv",
      size: 777,
      quality: { quality: { name: "WEBDL-1080p" } }
    };
    try {
      const r2 = await syncSource(db, src);
      expect(r2.relinked).toBe(1);
      expect(r2.removed).toBe(1);
      const rows = db.prepare("SELECT external_id, path, status FROM media_files ORDER BY external_id").all();
      expect(rows).toEqual([
        { external_id: "1", path: "/movies/Alpha (2020) [WEBDL-1080p][PROPER].mkv", status: "unchecked" }
      ]);
    } finally {
      MOVIES[0].movieFile = original;
    }
  });

  it("unmonitored movies without files are not tracked", async () => {
    const db = makeDb();
    const src = insertSource(db, "radarr", url, "good-key");
    await syncSource(db, src);
    const original = { monitored: MOVIES[0].monitored, movieFile: MOVIES[0].movieFile };
    MOVIES[0].monitored = false;
    MOVIES[0].movieFile = null;
    try {
      const r = await syncSource(db, src);
      expect(r.added).toBe(0);
      expect(r.removed).toBe(1); // the row disappears with its *arr entry
      expect(db.prepare("SELECT id FROM media_files").all()).toEqual([]);
    } finally {
      MOVIES[0].monitored = original.monitored;
      MOVIES[0].movieFile = original.movieFile;
    }
  });

  it("a purged row stays purged when sync sees it without a file", async () => {
    const db = makeDb();
    const src = insertSource(db, "radarr", url, "good-key");
    await syncSource(db, src);
    db.prepare("UPDATE media_files SET status = 'purged'").run();
    const original = MOVIES[0].movieFile;
    MOVIES[0].movieFile = null;
    try {
      const r = await syncSource(db, src);
      expect(r.updated).toBe(1);
      expect(r.removed).toBe(0);
      const row = db.prepare("SELECT path, status FROM media_files").get() as {
        path: string | null;
        status: string;
      };
      expect(row.path).toBeNull();
      expect(row.status).toBe("purged"); // still waiting for the replacement
    } finally {
      MOVIES[0].movieFile = original;
    }
  });

  it("sonarr: tracks monitored episodes without files as missing", async () => {
    const db = makeDb();
    const src = insertSource(db, "sonarr", url, "good-key");
    const original = EPISODES[2].monitored;
    EPISODES[2].monitored = true;
    try {
      const r = await syncSource(db, src);
      expect(r.added).toBe(3);
      const row = db.prepare("SELECT path, status FROM media_files WHERE external_id = '13'").get() as {
        path: string | null;
        status: string;
      };
      expect(row.path).toBeNull();
      expect(row.status).toBe("missing");
    } finally {
      EPISODES[2].monitored = original;
    }
  });

  it("surfaces auth failures with a clear message", async () => {
    const db = makeDb();
    const src = insertSource(db, "radarr", url, "wrong-key");
    await expect(syncSource(db, src)).rejects.toThrow(/Unauthorized/);
    const srow = db.prepare("SELECT last_sync_error FROM sources WHERE id = 1").get() as {
      last_sync_error: string | null;
    };
    expect(srow.last_sync_error).toBeNull(); // syncSource rethrows; caller records the error
  });

  describe("syncOneItem (single-item sync for per-file operations)", () => {
    function insertRow(
      db: DB,
      over: Partial<{
        source_id: number;
        kind: string;
        external_id: string;
        title: string;
        path: string | null;
        status: string;
        error_detail: string | null;
      }>
    ): number {
      const r = db
        .prepare(
          "INSERT INTO media_files (source_id, kind, external_id, title, path, status, error_detail)" +
            " VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          over.source_id ?? 1,
          over.kind ?? "movie",
          over.external_id ?? "1",
          over.title ?? "Row",
          over.path ?? null,
          over.status ?? "missing",
          over.error_detail ?? null
        );
      return Number(r.lastInsertRowid);
    }

    function rowById(db: DB, id: number): Record<string, unknown> | undefined {
      return db
        .prepare(
          "SELECT id, external_id, title, subtitle, path, size_bytes, quality, status, error_detail, checked_at FROM media_files WHERE id = ?"
        )
        .get(id) as Record<string, unknown> | undefined;
    }

    it("relinks a missing row when the download has landed, resetting it to unchecked", async () => {
      const db = makeDb();
      const src = insertSource(db, "radarr", url, "good-key");
      const id = insertRow(db, { external_id: "9", status: "missing" });
      MOVIES.push({
        id: 9,
        title: "Nine",
        year: 2026,
        monitored: true,
        movieFile: { path: "/movies/nine.mkv", size: 999, quality: { quality: { name: "WEBDL-1080p" } } }
      });
      try {
        const r = await syncOneItem(db, src, { id, externalId: "9" });
        expect(r).toEqual({ found: true, changed: true });
        expect(rowById(db, id)).toMatchObject({
          path: "/movies/nine.mkv",
          status: "unchecked",
          size_bytes: 999,
          quality: "WEBDL-1080p",
          title: "Nine",
          error_detail: null,
          checked_at: null
        });
      } finally {
        MOVIES.pop();
      }
    });

    it("keeps the verdict when the path is unchanged and refreshes metadata", async () => {
      const db = makeDb();
      const src = insertSource(db, "radarr", url, "good-key");
      await syncSource(db, src); // creates the /movies/alpha.mkv row
      db.prepare("UPDATE media_files SET status = 'corrupt', error_detail = 'boom' WHERE id = 1").run();
      const r = await syncOneItem(db, src, { id: 1, externalId: "1" });
      expect(r).toEqual({ found: true, changed: false });
      expect(rowById(db, 1)).toMatchObject({
        path: "/movies/alpha.mkv",
        status: "corrupt",
        error_detail: "boom",
        size_bytes: 123,
        quality: "WEBDL-1080p"
      });
    });

    it("parks the row as missing when the *arr no longer has the file", async () => {
      const db = makeDb();
      const src = insertSource(db, "radarr", url, "good-key");
      await syncSource(db, src);
      db.prepare("UPDATE media_files SET status = 'corrupt', error_detail = 'boom' WHERE id = 1").run();
      const original = MOVIES[0].movieFile;
      MOVIES[0].movieFile = null;
      try {
        const r = await syncOneItem(db, src, { id: 1, externalId: "1" });
        expect(r).toEqual({ found: true, changed: true });
        expect(rowById(db, 1)).toMatchObject({
          path: null,
          status: "missing",
          error_detail: null,
          size_bytes: null
        });
      } finally {
        MOVIES[0].movieFile = original;
      }
    });

    it("keeps a purged row purged while the *arr still has no file", async () => {
      const db = makeDb();
      const src = insertSource(db, "radarr", url, "good-key");
      await syncSource(db, src);
      db.prepare("UPDATE media_files SET status = 'purged' WHERE id = 1").run();
      const original = MOVIES[0].movieFile;
      MOVIES[0].movieFile = null;
      try {
        const r = await syncOneItem(db, src, { id: 1, externalId: "1" });
        expect(r).toEqual({ found: true, changed: true });
        expect(rowById(db, 1)).toMatchObject({ path: null, status: "purged" });
      } finally {
        MOVIES[0].movieFile = original;
      }
    });

    it("removes the row when the *arr no longer knows the item", async () => {
      const db = makeDb();
      const src = insertSource(db, "radarr", url, "good-key");
      const id = insertRow(db, { external_id: "777", path: "/movies/gone.mkv", status: "healthy" });
      const r = await syncOneItem(db, src, { id, externalId: "777" });
      expect(r).toEqual({ found: false, changed: true });
      expect(rowById(db, id)).toBeUndefined();
    });

    it("removes the row when the item became unmonitored with no file", async () => {
      const db = makeDb();
      const src = insertSource(db, "radarr", url, "good-key");
      await syncSource(db, src);
      const original = { monitored: MOVIES[0].monitored, movieFile: MOVIES[0].movieFile };
      MOVIES[0].monitored = false;
      MOVIES[0].movieFile = null;
      try {
        const r = await syncOneItem(db, src, { id: 1, externalId: "1" });
        expect(r).toEqual({ found: false, changed: true });
        expect(rowById(db, 1)).toBeUndefined();
      } finally {
        MOVIES[0].monitored = original.monitored;
        MOVIES[0].movieFile = original.movieFile;
      }
    });

    it("does not relink onto a path another row already owns", async () => {
      const db = makeDb();
      const src = insertSource(db, "radarr", url, "good-key");
      await syncSource(db, src); // row 1 owns /movies/alpha.mkv
      const id = insertRow(db, { external_id: "22", status: "missing" });
      MOVIES.push({
        id: 22,
        title: "Shared",
        year: 2027,
        monitored: true,
        movieFile: { path: "/movies/alpha.mkv", size: 1, quality: { quality: { name: "WEBDL-1080p" } } }
      });
      try {
        const r = await syncOneItem(db, src, { id, externalId: "22" });
        expect(r).toEqual({ found: true, changed: false });
        expect(rowById(db, id)).toMatchObject({ path: null, status: "missing" });
        expect(rowById(db, 1)).toMatchObject({ path: "/movies/alpha.mkv", external_id: "1" });
      } finally {
        MOVIES.pop();
      }
    });

    it("relinks a missing episode row with the series title and season/episode subtitle", async () => {
      const db = makeDb();
      const src = insertSource(db, "sonarr", url, "good-key");
      const id = insertRow(db, {
        kind: "episode",
        external_id: "13",
        title: "Old Title",
        status: "missing"
      });
      const original = { monitored: EPISODES[2].monitored, episodeFile: EPISODES[2].episodeFile };
      EPISODES[2].monitored = true;
      EPISODES[2].episodeFile = {
        path: "/tv/beta/s01e04.mkv",
        size: 313,
        quality: { quality: { name: "HDTV-720p" } }
      };
      try {
        const r = await syncOneItem(db, src, { id, externalId: "13" });
        expect(r).toEqual({ found: true, changed: true });
        expect(rowById(db, id)).toMatchObject({
          title: "Beta Show",
          path: "/tv/beta/s01e04.mkv",
          status: "unchecked",
          size_bytes: 313
        });
        expect(String(rowById(db, id)!.subtitle)).toContain("S01E04");
      } finally {
        EPISODES[2].monitored = original.monitored;
        EPISODES[2].episodeFile = original.episodeFile;
      }
    });

    it("propagates *arr failures", async () => {
      const db = makeDb();
      const src = insertSource(db, "radarr", url, "wrong-key");
      const id = insertRow(db, { external_id: "1", path: "/movies/alpha.mkv", status: "healthy" });
      await expect(syncOneItem(db, src, { id, externalId: "1" })).rejects.toThrow(/Unauthorized/);
      expect(rowById(db, id)).toMatchObject({ status: "healthy" }); // failure changed nothing
    });
  });
});
