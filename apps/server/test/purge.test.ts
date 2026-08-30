import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { migrate, type DB } from "../src/db.js";
import { purgeCorrupt } from "../src/services/purge.js";

function makeDb(): DB {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function seed(db: DB): void {
  db.prepare("INSERT INTO sources (id, type, name, base_url, api_key) VALUES (1, 'radarr', 'Radarr', ?, 'k')").run("");
  db.prepare("INSERT INTO sources (id, type, name, base_url, api_key) VALUES (2, 'sonarr', 'Sonarr', ?, 'k')").run("");
  const ins = db.prepare(
    "INSERT INTO media_files (source_id, kind, external_id, title, path, status) VALUES (?, ?, ?, ?, ?, ?)"
  );
  ins.run(1, "movie", "1", "Movie A", "/movies/a.mkv", "corrupt");   // radarr: has movieFile 101 -> delete
  ins.run(1, "movie", "2", "Movie B", "/movies/b.mkv", "corrupt");   // radarr: no movieFile -> skip
  ins.run(1, "movie", "3", "Healthy", "/movies/c.mkv", "healthy");   // never touched
  ins.run(2, "episode", "11", "Show", "/tv/s01e01.mkv", "corrupt");  // sonarr: episodeFileId 201 -> delete
  ins.run(2, "episode", "12", "Show", "/tv/s01e02.mkv", "corrupt");  // sonarr: no file -> skip
}

describe("purgeCorrupt", () => {
  let radarr: Server;
  let sonarr: Server;
  let radarrUrl: string;
  let sonarrUrl: string;
  let deletes: string[];
  let commands: { app: string; body: unknown }[];

  beforeAll(async () => {
    deletes = [];
    commands = [];
    const json = (res: import("node:http").ServerResponse, body: unknown, code = 200) =>
      res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));

    radarr = createServer((req, res) => {
      if (req.headers["x-api-key"] !== "k") return json(res, {}, 401);
      const u = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && u.pathname === "/api/v3/movie/1") return json(res, { id: 1, movieFile: { id: 101, path: "/movies/a.mkv" } });
      if (req.method === "GET" && u.pathname === "/api/v3/movie/2") return json(res, { id: 2, movieFile: null });
      if (req.method === "DELETE" && u.pathname === "/api/v3/moviefile/101") {
        deletes.push("radarr:" + u.pathname);
        return json(res, { id: 101 });
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
      if (req.method === "GET" && u.pathname === "/api/v3/episode/11") return json(res, { id: 11, episodeFileId: 201, hasFile: true });
      if (req.method === "GET" && u.pathname === "/api/v3/episode/12") return json(res, { id: 12, episodeFileId: null, hasFile: false });
      if (req.method === "DELETE" && u.pathname === "/api/v3/episodefile/201") {
        deletes.push("sonarr:" + u.pathname);
        return json(res, { id: 201 });
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

    await new Promise<void>((resolve) => radarr.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => sonarr.listen(0, "127.0.0.1", resolve));
    radarrUrl = "http://127.0.0.1:" + (radarr.address() as { port: number }).port;
    sonarrUrl = "http://127.0.0.1:" + (sonarr.address() as { port: number }).port;
  });

  afterAll(() => Promise.all([
    new Promise<void>((resolve) => radarr.close(() => resolve())),
    new Promise<void>((resolve) => sonarr.close(() => resolve()))
  ]));

  it("deletes only corrupt files that *arr still has, then batches searches", async () => {
    const db = makeDb();
    seed(db);
    // point the sources at the fakes
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

    expect(deletes.sort()).toEqual(["radarr:/api/v3/moviefile/101", "sonarr:/api/v3/episodefile/201"]);

    const radCmd = commands.find((c) => c.app === "radarr")!.body as { name: string; movieIds: number[] };
    expect(radCmd.name).toBe("MoviesSearch");
    expect(radCmd.movieIds).toEqual([1]);
    const sonCmd = commands.find((c) => c.app === "sonarr")!.body as { name: string; episodeIds: number[] };
    expect(sonCmd.name).toBe("EpisodesSearch");
    expect(sonCmd.episodeIds).toEqual([11]);
  });

  it("handles sources with no corrupt files", async () => {
    const db = makeDb();
    seed(db);
    db.prepare("UPDATE sources SET base_url = ? WHERE id = 1").run(radarrUrl);
    db.prepare("UPDATE sources SET base_url = ? WHERE id = 2").run(sonarrUrl);
    db.prepare("UPDATE media_files SET status = 'healthy' WHERE status = 'corrupt'").run();
    const result = await purgeCorrupt(db);
    expect(result.total).toBe(0);
    expect(result.results).toHaveLength(0);
    expect(deletes).toHaveLength(2); // unchanged from the previous test
  });
});
