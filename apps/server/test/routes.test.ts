import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";

// Never spawn real binaries in route tests.
vi.mock("../src/services/ffmpeg.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/ffmpeg.js")>();
  return { ...actual, binariesUsable: vi.fn(async () => null) };
});

import { migrate, type DB } from "../src/db.js";
import { buildApp } from "../src/app.js";

let db: DB;
let app: FastifyInstance;
let dir: string;
let fileId: number;

beforeAll(async () => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  db.prepare(
    "INSERT INTO sources (type, name, base_url, api_key) VALUES ('radarr', 'R', 'http://127.0.0.1:1', 'secret-key-1234')"
  ).run();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkarr-routes-"));
  const mediaPath = path.join(dir, "media.mp4");
  fs.writeFileSync(mediaPath, "0123456789abcdef");
  fileId = Number(
    db
      .prepare(
        "INSERT INTO media_files (source_id, kind, external_id, title, path) VALUES (1, 'movie', '1', 'A', ?)"
      )
      .run(mediaPath).lastInsertRowid
  );
  app = await buildApp(db);
});

afterAll(async () => {
  await app.close();
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
