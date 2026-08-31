import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fetchArr } from "../src/services/sync.js";

describe("fetchArr body handling", () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://localhost");
      if (u.pathname === "/empty204") { res.writeHead(204); res.end(); return; }
      if (u.pathname === "/empty200") { res.writeHead(200); res.end(); return; }
      if (u.pathname === "/html") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>auth proxy</html>"); return; }
      if (u.pathname === "/json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("returns null for a 204 with an empty body (real *arr DELETE behavior)", async () => {
    expect(await fetchArr(url, "k", "/empty204", { method: "DELETE" })).toBeNull();
  });

  it("returns null for a 200 with an empty body", async () => {
    expect(await fetchArr(url, "k", "/empty200")).toBeNull();
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
});
