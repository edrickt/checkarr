import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { migrate, type DB } from "../src/db.js";
import { purgeCorrupt, purgeFiles } from "../src/services/purge.js";

function makeDb(): DB {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function seed(db: DB): void {
  db.prepare(
    "INSERT INTO sources (id, type, name, base_url, api_key) VALUES (1, 'radarr', 'Radarr', ?, 'k')"
  ).run("");
  db.prepare(
    "INSERT INTO sources (id, type, name, base_url, api_key) VALUES (2, 'sonarr', 'Sonarr', ?, 'k')"
  ).run("");
  const ins = db.prepare(
    "INSERT INTO media_files (source_id, kind, external_id, title, path, status) VALUES (?, ?, ?, ?, ?, ?)"
  );
  ins.run(1, "movie", "1", "Movie A", "/movies/a.mkv", "corrupt"); // radarr: movieFile 101 at same path -> delete
  ins.run(1, "movie", "2", "Movie B", "/movies/b.mkv", "corrupt"); // radarr: no movieFile -> skip
  ins.run(1, "movie", "3", "Healthy", "/movies/c.mkv", "healthy"); // never touched
  ins.run(2, "episode", "11", "Show", "/tv/s01e01.mkv", "corrupt"); // sonarr: episodeFile 201 at same path -> delete
  ins.run(2, "episode", "12", "Show", "/tv/s01e02.mkv", "corrupt"); // sonarr: no file -> skip
}

describe("purge", () => {
  let radarr: Server;
  let sonarr: Server;
  let radarrFail: Server;
  let radarrUrl: string;
  let sonarrUrl: string;
  let radarrFailUrl: string;
  let deletes: string[];
  let commands: { app: string; body: unknown }[];

  beforeAll(async () => {
    deletes = [];
    commands = [];
    const json = (res: import("node:http").ServerResponse, body: unknown, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // Real Radarr/Sonarr DELETE endpoints answer 204 with an EMPTY body.
    const noContent = (res: import("node:http").ServerResponse) => {
      res.writeHead(204);
      res.end();
    };

    radarr = createServer((req, res) => {
      if (req.headers["x-api-key"] !== "k") return json(res, {}, 401);
      const u = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && u.pathname === "/api/v3/movie/1")
        return json(res, { id: 1, movieFile: { id: 101, path: "/movies/a.mkv" } });
      if (req.method === "GET" && u.pathname === "/api/v3/movie/2")
        return json(res, { id: 2, movieFile: null });
      if (req.method === "GET" && u.pathname === "/api/v3/movie/4")
        return json(res, { id: 4, movieFile: { id: 404, path: "/movies/moved-elsewhere.mkv" } });
      if (req.method === "DELETE" && u.pathname === "/api/v3/moviefile/101") {
        deletes.push("radarr:101");
        return noContent(res);
      }
      if (req.method === "POST" && u.pathname === "/api/v3/command") {
        let body = "";
        req.on("data", (c) => (body += c));
        return req.on("end", () => {
          commands.push({ app: "radarr", body: JSON.parse(body) });
          json(res, { id: 1 }, 201);
        });
      }
      res.writeHead(404).end("{}");
    });

    sonarr = createServer((req, res) => {
      if (req.headers["x-api-key"] !== "k") return json(res, {}, 401);
      const u = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && u.pathname === "/api/v3/episode/11")
        return json(res, {
          id: 11,
          episodeFileId: 201,
          hasFile: true,
          episodeFile: { id: 201, path: "/tv/s01e01.mkv" }
        });
      if (req.method === "GET" && u.pathname === "/api/v3/episode/12")
        return json(res, { id: 12, episodeFileId: null, hasFile: false, episodeFile: null });
      if (req.method === "GET" && u.pathname === "/api/v3/episode/13")
        return json(res, {
          id: 13,
          episodeFileId: 202,
          hasFile: true,
          episodeFile: { id: 202, path: "/tv/renamed.mkv" }
        });
      if (req.method === "DELETE" && u.pathname === "/api/v3/episodefile/201") {
        deletes.push("sonarr:201");
        return noContent(res);
      }
      if (req.method === "POST" && u.pathname === "/api/v3/command") {
        let body = "";
        req.on("data", (c) => (body += c));
        return req.on("end", () => {
          commands.push({ app: "sonarr", body: JSON.parse(body) });
          json(res, { id: 2 }, 201);
        });
      }
      res.writeHead(404).end("{}");
    });

    // radarrFail: deletes succeed but the replacement-search command fails.
    radarrFail = createServer((req, res) => {
      if (req.headers["x-api-key"] !== "k") return json(res, {}, 401);
      const u = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && u.pathname === "/api/v3/movie/6")
        return json(res, { id: 6, movieFile: { id: 600, path: "/movies/g.mkv" } });
      if (req.method === "DELETE" && u.pathname === "/api/v3/moviefile/600") {
        deletes.push("radarrFail:600");
        return noContent(res);
      }
      if (req.method === "POST" && u.pathname === "/api/v3/command") {
        let body = "";
        req.on("data", (c) => (body += c));
        return req.on("end", () => json(res, { message: "boom" }, 500));
      }
      res.writeHead(404).end("{}");
    });

    await Promise.all([
      new Promise<void>((resolve) => radarr.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => sonarr.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => radarrFail.listen(0, "127.0.0.1", resolve))
    ]);
    radarrUrl = "http://127.0.0.1:" + (radarr.address() as { port: number }).port;
    sonarrUrl = "http://127.0.0.1:" + (sonarr.address() as { port: number }).port;
    radarrFailUrl = "http://127.0.0.1:" + (radarrFail.address() as { port: number }).port;
  });

  beforeEach(() => {
    deletes.length = 0;
    commands.length = 0;
  });

  afterAll(() =>
    Promise.all([
      new Promise<void>((resolve) => radarr.close(() => resolve())),
      new Promise<void>((resolve) => sonarr.close(() => resolve())),
      new Promise<void>((resolve) => radarrFail.close(() => resolve()))
    ])
  );

  it("deletes corrupt files with empty-body DELETE responses, then batches searches", async () => {
    const db = makeDb();
    seed(db);
    db.prepare("UPDATE sources SET base_url = ? WHERE id = 1").run(radarrUrl);
    db.prepare("UPDATE sources SET base_url = ? WHERE id = 2").run(sonarrUrl);

    const result = await purgeCorrupt(db);
    expect(result.total).toBe(2);
    expect(result.results).toHaveLength(2);

    const rad = result.results.find((r) => r.type === "radarr")!;
    expect(rad.deleted).toBe(1);
    expect(rad.skipped).toBe(1);
    expect(rad.searched).toBe(1);
    expect(rad.errors).toEqual([]);

    const son = result.results.find((r) => r.type === "sonarr")!;
    expect(son.deleted).toBe(1);
    expect(son.skipped).toBe(1);
    expect(son.searched).toBe(1);

    expect(deletes.sort()).toEqual(["radarr:101", "sonarr:201"]);

    const radCmd = commands.find((c) => c.app === "radarr")!.body as { name: string; movieIds: number[] };
    expect(radCmd.name).toBe("MoviesSearch");
    expect(radCmd.movieIds).toEqual([1]);
    const sonCmd = commands.find((c) => c.app === "sonarr")!.body as { name: string; episodeIds: number[] };
    expect(sonCmd.name).toBe("EpisodesSearch");
    expect(sonCmd.episodeIds).toEqual([11]);
  });

  it("skips files whose *arr path changed since the scan", async () => {
    const db = makeDb();
    seed(db);
    const ins = db.prepare(
      "INSERT INTO media_files (source_id, kind, external_id, title, path, status) VALUES (?, ?, ?, ?, ?, ?)"
    );
    ins.run(1, "movie", "4", "Movie D", "/movies/old.mkv", "corrupt"); // radarr now points elsewhere
    ins.run(2, "episode", "13", "Show", "/tv/old.mkv", "corrupt"); // sonarr now points elsewhere
    db.prepare("UPDATE sources SET base_url = ? WHERE id = 1").run(radarrUrl);
    db.prepare("UPDATE sources SET base_url = ? WHERE id = 2").run(sonarrUrl);

    const result = await purgeCorrupt(db);
    const rad = result.results.find((r) => r.sourceId === 1)!;
    const son = result.results.find((r) => r.sourceId === 2)!;
    expect(rad.deleted).toBe(1);
    expect(son.deleted).toBe(1);
    expect(rad.errors.join(" ")).toMatch(/re-sync and re-scan/);
    expect(son.errors.join(" ")).toMatch(/re-sync and re-scan/);
    // Only the still-matching files were deleted.
    expect(deletes.sort()).toEqual(["radarr:101", "sonarr:201"]);
  });

  it("keeps deleted counts and reports the failure when the replacement search fails", async () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO sources (id, type, name, base_url, api_key) VALUES (4, 'radarr', 'RadarrFail', ?, 'k')"
    ).run("");
    db.prepare(
      "INSERT INTO media_files (source_id, kind, external_id, title, path, status) VALUES (4, 'movie', '6', 'Movie G', '/movies/g.mkv', 'corrupt')"
    ).run();
    db.prepare("UPDATE sources SET base_url = ? WHERE id = 4").run(radarrFailUrl);

    const result = await purgeFiles(db, { sourceId: 4 });
    expect(result.total).toBe(1);
    expect(result.results[0]!.deleted).toBe(1);
    expect(result.results[0]!.searched).toBe(0);
    expect(result.results[0]!.errors[0]).toMatch(/replacement search failed/);
    expect(deletes).toEqual(["radarrFail:600"]);
  });

  it("skips disabled sources entirely", async () => {
    const db = makeDb();
    seed(db);
    db.prepare("UPDATE sources SET base_url = ? WHERE id = 1").run(radarrUrl);
    db.prepare("UPDATE sources SET base_url = ? WHERE id = 2").run(sonarrUrl);
    db.prepare(
      "INSERT INTO sources (id, type, name, base_url, api_key, enabled) VALUES (3, 'radarr', 'Off', ?, 'k', 0)"
    ).run(radarrUrl);
    db.prepare(
      "INSERT INTO media_files (source_id, kind, external_id, title, path, status) VALUES (3, 'movie', '1', 'Off Movie', '/movies/a.mkv', 'corrupt')"
    ).run();

    const result = await purgeCorrupt(db);
    expect(result.results.find((r) => r.sourceId === 3)).toBeUndefined();
    expect(deletes.sort()).toEqual(["radarr:101", "sonarr:201"]);
  });

  it("purges a single file by id", async () => {
    const db = makeDb();
    seed(db);
    db.prepare("UPDATE sources SET base_url = ? WHERE id = 1").run(radarrUrl);
    db.prepare("UPDATE sources SET base_url = ? WHERE id = 2").run(sonarrUrl);

    const result = await purgeFiles(db, { fileId: 1 });
    expect(result.total).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.type).toBe("radarr");
    expect(result.results[0]!.deleted).toBe(1);
    expect(result.results[0]!.searched).toBe(1);
    expect(deletes).toEqual(["radarr:101"]);
  });

  it("purges only the selected source", async () => {
    const db = makeDb();
    seed(db);
    db.prepare("UPDATE sources SET base_url = ? WHERE id = 1").run(radarrUrl);
    db.prepare("UPDATE sources SET base_url = ? WHERE id = 2").run(sonarrUrl);

    const result = await purgeFiles(db, { status: "corrupt", sourceId: 2 });
    expect(result.total).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.type).toBe("sonarr");
    expect(deletes).toEqual(["sonarr:201"]);
  });
});
