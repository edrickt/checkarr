import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";

// Never spawn real binaries in route tests.
vi.mock("../src/services/ffmpeg.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/ffmpeg.js")>();
  return { ...actual, binariesUsable: vi.fn(async () => null) };
});

// The checker is replaced so a scan can be held in flight for the
// sync-during-scan test; nothing in this file checks a real path.
const checkMock = vi.fn();
vi.mock("../src/services/checker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/checker.js")>();
  return { ...actual, checkMediaFile: (...args: unknown[]) => checkMock(...args) };
});

import { migrate, type DB } from "../src/db.js";
import type { CheckOutcome } from "../src/services/checker.js";
import { buildApp } from "../src/app.js";

let db: DB;
let app: FastifyInstance;
let dir: string;
let fileId: number;

// Route tests never check a real path: stand in for the checker with the one
// behavior the non-scan tests rely on - a vanished file reports missing.
function defaultCheck(path: string): Promise<CheckOutcome> {
  return Promise.resolve(
    fs.existsSync(path)
      ? { status: "healthy", detail: null, probe: null }
      : { status: "missing", detail: "no such file", probe: null }
  );
}

let stubMovies: Record<
  string,
  | {
      id: number;
      title: string;
      year: number;
      monitored: boolean;
      movieFile: { id: number; path: string; size: number; quality: { quality: { name: string } } } | null;
    }
  | undefined
>;
let stubDeletes: string[];
let arrStub: Server;
let arrStubUrl: string;

beforeAll(async () => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkarr-routes-"));
  const mediaPath = path.join(dir, "media.mp4");
  fs.writeFileSync(mediaPath, "0123456789abcdef");
  // More on-disk files: fixtures that "just downloaded" must not collide
  // with each other or the long-lived row's path (UNIQUE (source_id, path)).
  fs.writeFileSync(path.join(dir, "fresh.mp4"), "fedcba9876543210");
  fs.writeFileSync(path.join(dir, "scan.mp4"), "0123456789abcdef0");
  fs.writeFileSync(path.join(dir, "purge.mp4"), "0123456789abcdef00");

  // Single-item operations (recheck, per-file purge) sync the item from its
  // *arr first, so the route tests need a stub Radarr to answer those calls.
  stubMovies = {
    // Row '1' is the long-lived test row; no movieFile = the purged-recheck
    // test's "replacement not on disk yet" state.
    "1": { id: 1, title: "A", year: 2020, monitored: true, movieFile: null },
    // Row '9' is the null-path (monitored, not downloaded) test row.
    "9": { id: 9, title: "Not Yet", year: 2026, monitored: true, movieFile: null }
  };
  stubDeletes = [];
  arrStub = createServer((req, res) => {
    if (req.headers["x-api-key"] !== "secret-key-1234") {
      res.writeHead(401).end("{}");
      return;
    }
    const u = new URL(req.url ?? "/", "http://localhost");
    // Library listing used by batch-operation syncs. The long-lived row's
    // movie keeps its file here (unlike the single-item fixture above), so a
    // batch sync upserts row 1 in place instead of unparking it.
    if (req.method === "GET" && u.pathname === "/api/v3/movie") {
      const list = Object.values(stubMovies)
        .filter((m) => m !== undefined)
        .map((m) =>
          m.id === 1
            ? {
                ...m,
                movieFile: {
                  id: 1000,
                  path: path.join(dir, "media.mp4"),
                  size: 16,
                  quality: { quality: { name: "WEBDL-1080p" } }
                }
              }
            : m
        );
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(list));
      return;
    }
    const one = /^\/api\/v3\/movie\/(\d+)$/.exec(u.pathname);
    if (req.method === "GET" && one) {
      const movie = stubMovies[one[1]];
      if (!movie) {
        res.writeHead(404).end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(movie));
      return;
    }
    if (req.method === "DELETE" && /^\/api\/v3\/moviefile\/\d+$/.test(u.pathname)) {
      stubDeletes.push(u.pathname);
      res.writeHead(204).end();
      return;
    }
    if (req.method === "POST" && u.pathname === "/api/v3/command") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => {
        res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: 1 }));
      });
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => arrStub.listen(0, "127.0.0.1", resolve));
  arrStubUrl = "http://127.0.0.1:" + (arrStub.address() as { port: number }).port;

  db.prepare(
    "INSERT INTO sources (type, name, base_url, api_key) VALUES ('radarr', 'R', ?, 'secret-key-1234')"
  ).run(arrStubUrl);
  fileId = Number(
    db
      .prepare(
        "INSERT INTO media_files (source_id, kind, external_id, title, path) VALUES (1, 'movie', '1', 'A', ?)"
      )
      .run(mediaPath).lastInsertRowid
  );
  app = await buildApp(db);
  checkMock.mockImplementation(defaultCheck);
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => arrStub.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("host + cross-site guards", () => {
  it("serves normal requests on local hosts", async () => {
    const r = await app.inject({ method: "GET", url: "/api/stats", headers: { host: "127.0.0.1:5656" } });
    expect(r.statusCode).toBe(200);
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const r = await app.inject({ method: "GET", url: "/api/sources", headers: { host: "evil.com" } });
    expect(r.statusCode).toBe(403);
  });

  it("rejects cross-origin writes but allows same-origin", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/scan/cancel",
      headers: { origin: "http://evil.com" },
      payload: {}
    });
    expect(bad.statusCode).toBe(403);
    const good = await app.inject({
      method: "POST",
      url: "/api/scan/cancel",
      headers: { host: "127.0.0.1:5656", origin: "http://127.0.0.1:5656" },
      payload: {}
    });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ ok: true });
  });

  it("rejects browser-labelled cross-site writes (Sec-Fetch-Site)", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/scan/cancel",
      headers: { "sec-fetch-site": "cross-site" },
      payload: {}
    });
    expect(r.statusCode).toBe(403);
  });

  it("blocks text/plain write bodies (the no-cors CSRF vector)", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/purge",
      payload: "x",
      headers: { "content-type": "text/plain" }
    });
    expect(r.statusCode).toBe(415);
  });
});

describe("stream + Range", () => {
  it("serves the full file with 200", async () => {
    const r = await app.inject({ method: "GET", url: "/api/files/" + fileId + "/stream" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("0123456789abcdef");
  });

  it("serves an explicit range with 206 + content-range", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/files/" + fileId + "/stream",
      headers: { range: "bytes=2-5" }
    });
    expect(r.statusCode).toBe(206);
    expect(r.body).toBe("2345");
    expect(r.headers["content-range"]).toBe("bytes 2-5/16");
  });

  it("clamps an oversized end like a player would send", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/files/" + fileId + "/stream",
      headers: { range: "bytes=10-999" }
    });
    expect(r.statusCode).toBe(206);
    expect(r.body).toBe("abcdef");
  });

  it("answers 416 on unsatisfiable ranges", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/files/" + fileId + "/stream",
      headers: { range: "bytes=99-" }
    });
    expect(r.statusCode).toBe(416);
    expect(r.headers["content-range"]).toBe("bytes */16");
  });

  it("answers 416 for a suffix range on a 0-byte file (used to 500)", async () => {
    const emptyPath = path.join(dir, "empty.mp4");
    fs.writeFileSync(emptyPath, "");
    const eid = Number(
      db
        .prepare(
          "INSERT INTO media_files (source_id, kind, external_id, title, path) VALUES (1, 'movie', '2', 'Empty', ?)"
        )
        .run(emptyPath).lastInsertRowid
    );
    const r = await app.inject({
      method: "GET",
      url: "/api/files/" + eid + "/stream",
      headers: { range: "bytes=-1" }
    });
    expect(r.statusCode).toBe(416);
  });

  it("validates file ids", async () => {
    const r = await app.inject({ method: "GET", url: "/api/files/abc/stream" });
    expect(r.statusCode).toBe(400);
  });
});

describe("validation", () => {
  it("rejects out-of-range concurrency", async () => {
    expect(
      (await app.inject({ method: "PUT", url: "/api/settings", payload: { concurrency: 0 } })).statusCode
    ).toBe(400);
    expect(
      (await app.inject({ method: "PUT", url: "/api/settings", payload: { concurrency: 33 } })).statusCode
    ).toBe(400);
  });

  it("rejects unknown scan scopes instead of coercing them", async () => {
    const r = await app.inject({ method: "POST", url: "/api/scan", payload: { scope: "deep" } });
    expect(r.statusCode).toBe(400);
  });

  it("rejects non-integer sourceId filters", async () => {
    const r = await app.inject({ method: "GET", url: "/api/files?sourceId=abc" });
    expect(r.statusCode).toBe(400);
  });

  it("rejects unknown file status filters instead of returning empty", async () => {
    const r = await app.inject({ method: "GET", url: "/api/files?status=bogus" });
    expect(r.statusCode).toBe(400);
  });

  it("parses enabled strictly (the string 'false' must disable, not enable)", async () => {
    const off = await app.inject({ method: "PUT", url: "/api/sources/1", payload: { enabled: "false" } });
    expect(off.statusCode).toBe(200);
    expect((db.prepare("SELECT enabled FROM sources WHERE id = 1").get() as any).enabled).toBe(0);
    const on = await app.inject({ method: "PUT", url: "/api/sources/1", payload: { enabled: "true" } });
    expect(on.statusCode).toBe(200);
    expect((db.prepare("SELECT enabled FROM sources WHERE id = 1").get() as any).enabled).toBe(1);
    const junk = await app.inject({ method: "PUT", url: "/api/sources/1", payload: { enabled: "banana" } });
    expect(junk.statusCode).toBe(400);
  });
});

describe("recheck", () => {
  it("keeps a purged row purged when the replacement is not on disk yet", async () => {
    const before = (db.prepare("SELECT status FROM media_files WHERE id = ?").get(fileId) as any).status;
    db.prepare("UPDATE media_files SET status = 'purged', path = ? WHERE id = ?").run(
      path.join(dir, "deleted-by-research.mkv"),
      fileId
    );
    try {
      const r = await app.inject({ method: "POST", url: "/api/files/" + fileId + "/recheck" });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ id: fileId, status: "purged" });
    } finally {
      db.prepare("UPDATE media_files SET status = ?, path = ? WHERE id = ?").run(
        before,
        path.join(dir, "media.mp4"),
        fileId
      );
    }
  });
});

describe("null-path rows (monitored, no file at the *arr)", () => {
  it("answers 404 on stream and reports missing on recheck", async () => {
    const id = Number(
      db
        .prepare(
          "INSERT INTO media_files (source_id, kind, external_id, title, path, status)" +
            " VALUES (1, 'movie', '9', 'Not Yet', NULL, 'missing')"
        )
        .run().lastInsertRowid
    );
    try {
      const stream = await app.inject({ method: "GET", url: "/api/files/" + id + "/stream" });
      expect(stream.statusCode).toBe(404);
      const re = await app.inject({ method: "POST", url: "/api/files/" + id + "/recheck" });
      expect(re.statusCode).toBe(200);
      expect(re.json()).toMatchObject({ id, status: "missing" });
    } finally {
      db.prepare("DELETE FROM media_files WHERE id = ?").run(id);
    }
  });
});

describe("sync during scan", () => {
  it("rejects a sync with 409 while a scan is running", async () => {
    // Hold the scan in flight until the test cancels it.
    checkMock.mockImplementation(
      (_path: string, ctx: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          ctx.signal?.addEventListener("abort", () => reject(new Error("scan cancelled")), { once: true });
        })
    );
    try {
      const started = await app.inject({ method: "POST", url: "/api/scan", payload: { scope: "all" } });
      expect(started.statusCode).toBe(200);
      let active = false;
      for (let i = 0; i < 100 && !active; i++) {
        await new Promise((r2) => setTimeout(r2, 20));
        const cur = await app.inject({ method: "GET", url: "/api/scan/current" });
        active = cur.json().active === true;
      }
      expect(active).toBe(true);

      const sync = await app.inject({ method: "POST", url: "/api/sync", payload: {} });
      expect(sync.statusCode).toBe(409);
      expect(sync.json()).toMatchObject({ error: "A scan is running - wait for it to finish or cancel it" });

      const cancel = await app.inject({ method: "POST", url: "/api/scan/cancel", payload: {} });
      expect(cancel.statusCode).toBe(200);
    } finally {
      // Never leak a running scan or the blocked checker into the other describes.
      await app.inject({ method: "POST", url: "/api/scan/cancel", payload: {} });
      await new Promise((r2) => setTimeout(r2, 50));
      checkMock.mockImplementation(defaultCheck);
    }
  });
});

describe("masked api keys", () => {
  it("masks keys in list responses", async () => {
    const r = await app.inject({ method: "GET", url: "/api/sources" });
    const src = r.json().sources[0];
    expect(src.apiKey).toBe("\u2022\u2022\u2022\u20221234");
    expect(JSON.stringify(src)).not.toContain("secret-key-1234");
  });

  it("keeps the stored key when the masked value is saved back", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/sources/1",
      payload: { name: "Renamed", apiKey: "\u2022\u2022\u2022\u20221234" }
    });
    expect(put.statusCode).toBe(200);
    expect((db.prepare("SELECT api_key FROM sources WHERE id = 1").get() as any).api_key).toBe(
      "secret-key-1234"
    );
    expect((db.prepare("SELECT name FROM sources WHERE id = 1").get() as any).name).toBe("Renamed");
  });
});

describe("single-item operations sync first", () => {
  it("re-check picks up a download that landed after the last library sync", async () => {
    // The reported bug: a row parked 'missing' stays missing forever through
    // re-checks, because only a full sync ever gave it a path.
    const id = Number(
      db
        .prepare(
          "INSERT INTO media_files (source_id, kind, external_id, title, path, status)" +
            " VALUES (1, 'movie', '10', 'Fresh', NULL, 'missing')"
        )
        .run().lastInsertRowid
    );
    stubMovies["10"] = {
      id: 10,
      title: "Fresh",
      year: 2026,
      monitored: true,
      movieFile: {
        id: 1000,
        path: path.join(dir, "fresh.mp4"),
        size: 16,
        quality: { quality: { name: "WEBDL-1080p" } }
      }
    };
    try {
      const r = await app.inject({ method: "POST", url: "/api/files/" + id + "/recheck" });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ id, status: "healthy" });
      const row = db
        .prepare("SELECT path, status, size_bytes, quality FROM media_files WHERE id = ?")
        .get(id) as any;
      expect(row.path).toBe(path.join(dir, "fresh.mp4"));
      expect(row.status).toBe("healthy");
      expect(row.size_bytes).toBe(16);
      expect(row.quality).toBe("WEBDL-1080p");
    } finally {
      delete stubMovies["10"];
      db.prepare("DELETE FROM media_files WHERE id = ?").run(id);
    }
  });

  it("re-check drops the row and answers 404 when the *arr no longer has the item", async () => {
    const id = Number(
      db
        .prepare(
          "INSERT INTO media_files (source_id, kind, external_id, title, path, status)" +
            " VALUES (1, 'movie', '99', 'Vanished', ?, 'healthy')"
        )
        .run(path.join(dir, "vanished.mkv")).lastInsertRowid
    );
    const r = await app.inject({ method: "POST", url: "/api/files/" + id + "/recheck" });
    expect(r.statusCode).toBe(404);
    expect(db.prepare("SELECT id FROM media_files WHERE id = ?").get(id)).toBeUndefined();
  });

  it("delete & re-search syncs first, so a missing row that just got its file is purgeable", async () => {
    const id = Number(
      db
        .prepare(
          "INSERT INTO media_files (source_id, kind, external_id, title, path, status)" +
            " VALUES (1, 'movie', '12', 'Just Landed', NULL, 'missing')"
        )
        .run().lastInsertRowid
    );
    stubMovies["12"] = {
      id: 12,
      title: "Just Landed",
      year: 2026,
      monitored: true,
      movieFile: {
        id: 1200,
        path: path.join(dir, "fresh.mp4"),
        size: 16,
        quality: { quality: { name: "WEBDL-1080p" } }
      }
    };
    try {
      const r = await app.inject({ method: "POST", url: "/api/files/" + id + "/purge", payload: {} });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ total: 1 });
      expect(stubDeletes.some((p) => p.endsWith("/1200"))).toBe(true);
      expect((db.prepare("SELECT status FROM media_files WHERE id = ?").get(id) as any).status).toBe(
        "purged"
      );
    } finally {
      delete stubMovies["12"];
      db.prepare("DELETE FROM media_files WHERE id = ?").run(id);
    }
  });

  it("re-check reports a clear sync failure (502) and touches nothing when the *arr is down", async () => {
    db.prepare(
      "INSERT INTO sources (id, type, name, base_url, api_key) VALUES (2, 'radarr', 'Down', 'http://127.0.0.1:1', 'k')"
    ).run();
    const id = Number(
      db
        .prepare(
          "INSERT INTO media_files (source_id, kind, external_id, title, path, status)" +
            " VALUES (2, 'movie', '5', 'Orphan', NULL, 'missing')"
        )
        .run().lastInsertRowid
    );
    try {
      const r = await app.inject({ method: "POST", url: "/api/files/" + id + "/recheck" });
      expect(r.statusCode).toBe(502);
      expect(r.json().error).toMatch(/cannot sync 'Down' from the \*arr before re-check/);
      // The failure left the stale row exactly as it was.
      expect((db.prepare("SELECT status FROM media_files WHERE id = ?").get(id) as any).status).toBe(
        "missing"
      );
    } finally {
      db.prepare("DELETE FROM media_files WHERE id = ?").run(id);
      db.prepare("DELETE FROM sources WHERE id = 2").run();
    }
  });
});

describe("batch operations sync first", () => {
  const waitForScanSettled = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const cur = await app.inject({ method: "GET", url: "/api/scan/current" });
      if (cur.json().active === false) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it("scan syncs the library first and picks up a download that landed after the last sync", async () => {
    stubMovies["20"] = {
      id: 20,
      title: "Scan Fresh",
      year: 2026,
      monitored: true,
      movieFile: {
        id: 2000,
        path: path.join(dir, "scan.mp4"),
        size: 17,
        quality: { quality: { name: "WEBDL-1080p" } }
      }
    };
    try {
      const r = await app.inject({ method: "POST", url: "/api/scan", payload: { scope: "all" } });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.runId).toBeGreaterThan(0);
      expect(body.synced).toHaveLength(1);
      expect(body.synced[0]).toMatchObject({
        sourceId: 1,
        ok: true,
        added: expect.any(Number),
        relinked: expect.any(Number),
        updated: expect.any(Number),
        removed: expect.any(Number),
        total: expect.any(Number)
      });
      // The sync pulled the new download in before the scan started.
      const row = db
        .prepare("SELECT path, size_bytes FROM media_files WHERE external_id = '20' AND source_id = 1")
        .get() as any;
      expect(row.path).toBe(path.join(dir, "scan.mp4"));
      expect(row.size_bytes).toBe(17);
      await waitForScanSettled();
      // The scan then checked the fresh file (it exists on disk).
      const checked = db
        .prepare("SELECT status FROM media_files WHERE external_id = '20' AND source_id = 1")
        .get() as any;
      expect(checked.status).toBe("healthy");
    } finally {
      await app.inject({ method: "POST", url: "/api/scan/cancel", payload: {} });
      delete stubMovies["20"];
      db.prepare("DELETE FROM media_files WHERE external_id = '20' AND source_id = 1").run();
    }
  });

  it("bulk purge syncs only the scoped source and can target what the sync just brought in", async () => {
    stubMovies["21"] = {
      id: 21,
      title: "Purge Fresh",
      year: 2026,
      monitored: true,
      movieFile: {
        id: 2100,
        path: path.join(dir, "purge.mp4"),
        size: 18,
        quality: { quality: { name: "WEBDL-1080p" } }
      }
    };
    try {
      const r = await app.inject({
        method: "POST",
        url: "/api/purge",
        payload: { status: "unchecked", sourceId: 1 }
      });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.total).toBe(1);
      expect(body.synced).toHaveLength(1);
      expect(body.synced[0]).toMatchObject({ sourceId: 1, ok: true });
      expect(stubDeletes.some((p) => p.endsWith("/2100"))).toBe(true);
      const row = db
        .prepare("SELECT status FROM media_files WHERE external_id = '21' AND source_id = 1")
        .get() as any;
      expect(row.status).toBe("purged");
    } finally {
      delete stubMovies["21"];
      db.prepare("DELETE FROM media_files WHERE external_id = '21' AND source_id = 1").run();
    }
  });

  it("scan aborts with a clear sync failure (502) when a source cannot be synced", async () => {
    db.prepare(
      "INSERT INTO sources (id, type, name, base_url, api_key) VALUES (2, 'radarr', 'Down', 'http://127.0.0.1:1', 'k')"
    ).run();
    try {
      const r = await app.inject({ method: "POST", url: "/api/scan", payload: { scope: "all" } });
      expect(r.statusCode).toBe(502);
      expect(r.json().error).toMatch(/cannot sync the library before scan - Down: /);
      // No scan may be left running behind the failed request.
      const cur = await app.inject({ method: "GET", url: "/api/scan/current" });
      expect(cur.json().active).toBe(false);
    } finally {
      db.prepare("DELETE FROM sources WHERE id = 2").run();
    }
  });

  it("bulk purge with no enabled sources cannot silently skip the sync", async () => {
    db.prepare("UPDATE sources SET enabled = 0 WHERE id = 1").run();
    try {
      const r = await app.inject({ method: "POST", url: "/api/purge", payload: { status: "corrupt" } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/no enabled sources to sync before delete/);
    } finally {
      db.prepare("UPDATE sources SET enabled = 1 WHERE id = 1").run();
    }
  });
});
