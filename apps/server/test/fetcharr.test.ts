import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fetchArr, testSource } from "../src/services/sync.js";

// What /api/v3/system/status answers; testSource must not call a broken body OK.
let statusMode: "ok" | "empty" | "array" = "ok";

describe("fetchArr body handling", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://localhost");
      if (u.pathname === "/api/v3/system/status") {
        if (statusMode === "empty") {
          res.writeHead(200);
          res.end();
          return;
        }
        if (statusMode === "array") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify([]));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ appName: "Radarr", version: "5.14.0" }));
        return;
      }
      if (u.pathname === "/empty204") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (u.pathname === "/empty200") {
        res.writeHead(200);
        res.end();
        return;
      }
      if (u.pathname === "/html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>auth proxy</html>");
        return;
      }
      if (u.pathname === "/json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (u.pathname === "/null-json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("null");
        return;
      }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  afterEach(() => {
    statusMode = "ok";
  });

  it("returns the not-found signal for a 204 with an empty body (real *arr DELETE behavior)", async () => {
    expect(await fetchArr(url, "k", "/empty204", { method: "DELETE" })).toBeUndefined();
  });

  it("throws for a 200 GET with an empty body (it is not a 404)", async () => {
    // The undefined "the *arr does not have this item" signal used to be null
    // for both a real 404 and an empty 2xx body, so syncOneItem deleted a
    // tracked row (and its history) when an auth proxy or a truncated response
    // answered 200 with no body.
    await expect(fetchArr(url, "k", "/empty200")).rejects.toThrow(/empty body/);
  });

  it("returns the not-found signal for an empty 200 on DELETE (preserved delete semantics)", async () => {
    expect(await fetchArr(url, "k", "/empty200", { method: "DELETE" })).toBeUndefined();
  });

  it("returns a parsed JSON null body as-is, never as the not-found signal", async () => {
    // JSON `null` is a wrong-shaped *arr response, not a 404. It must stay
    // distinct from the undefined "item does not exist" signal so
    // syncOneItem rejects it instead of deleting the tracked row.
    expect(await fetchArr(url, "k", "/null-json")).toBeNull();
  });

  it("parses non-empty JSON", async () => {
    expect(await fetchArr(url, "k", "/json")).toEqual({ ok: true });
  });

  it("errors clearly on non-JSON bodies, naming method and path", async () => {
    await expect(fetchArr(url, "k", "/html", { method: "DELETE" })).rejects.toThrow(/DELETE \/html/);
  });

  it("wraps connection failures with the base url", async () => {
    await expect(fetchArr("http://127.0.0.1:9", "k", "/api/v3/movie")).rejects.toThrow(/Cannot reach/);
  });

  describe("testSource", () => {
    it("reports a working *arr with its app name and version", async () => {
      expect(await testSource("radarr", url, "k")).toEqual({
        ok: true,
        appName: "Radarr",
        version: "5.14.0",
        mismatch: false
      });
    });

    it("flags an app-type mismatch instead of silently accepting it", async () => {
      const result = await testSource("sonarr", url, "k");
      expect(result.ok).toBe(true);
      expect(result.mismatch).toBe(true);
    });

    it("reports an empty 200 body as a failure, not OK", async () => {
      statusMode = "empty";
      const result = await testSource("radarr", url, "k");
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/empty body/);
    });

    it("reports a non-object body as a failure", async () => {
      statusMode = "array";
      const result = await testSource("radarr", url, "k");
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/unexpected response/);
    });
  });
});
