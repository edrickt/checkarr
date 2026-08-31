import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import { HOST, WEB_DIST } from "./config.js";
import { registerApi } from "./routes.js";
import { ScanManager } from "./services/scanner.js";
import type { DB } from "./db.js";

// Hostnames the UI may be opened on. The 127.0.0.1 bind alone is not a
// security boundary: without a Host check, DNS rebinding makes an attacker
// page same-origin with this API (API-key theft, media exfil, arbitrary file
// reads through re-written path mappings). When the server deliberately binds
// every interface (HOST=0.0.0.0, Docker), hostname checking is disabled by
// default; lock a LAN deployment down with CHECKARR_ALLOWED_HOSTS (comma-
// separated hostnames).
const ALLOWED_HOSTNAMES = new Set(
  ["127.0.0.1", "localhost", "::1", "[::1]"]
    .concat((process.env.CHECKARR_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()))
    .filter((h) => h.length > 0)
);
const BIND_ALL = HOST === "0.0.0.0" || HOST === "::";

function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const first = host.indexOf(":");
  const last = host.lastIndexOf(":");
  return first !== -1 && first === last ? host.slice(0, first) : host;
}

function requestHostAllowed(header: string | undefined): boolean {
  if (header === undefined) return true; // HTTP/1.0-style clients
  if (BIND_ALL) return true;
  return ALLOWED_HOSTNAMES.has(stripPort(header.toLowerCase()));
}

const MUTATING = new Set(["POST", "PUT", "DELETE", "PATCH"]);

export async function buildApp(db: DB): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const scans = new ScanManager(db);
  registerApi(app, db, scans);

  app.addHook("onRequest", async (req, reply) => {
    if (!requestHostAllowed(req.headers.host)) {
      return reply.code(403).send({ error: "unrecognized host - open the UI on localhost" });
    }
    if (MUTATING.has(req.method)) {
      // The API is unauthenticated by design, so cross-site writes must be
      // refused here: browsers label cross-site POSTs with Sec-Fetch-Site /
      // Origin, and a drive-by page cannot forge either.
      const site = req.headers["sec-fetch-site"];
      if (typeof site === "string" && site !== "same-origin" && site !== "none") {
        return reply.code(403).send({ error: "cross-site requests are not allowed" });
      }
      const origin = req.headers.origin;
      if (typeof origin === "string" && origin.length > 0) {
        let originHost: string;
        try {
          originHost = new URL(origin).host;
        } catch {
          return reply.code(403).send({ error: "invalid origin" });
        }
        if (originHost !== req.headers.host) {
          return reply.code(403).send({ error: "cross-origin requests are not allowed" });
        }
      }
      // Fastify parses text/plain bodies, which let no-cors form POSTs reach
      // destructive handlers with their defaults; writes must be JSON.
      const ct = req.headers["content-type"];
      if (ct !== undefined && !String(ct).split(";")[0]!.trim().toLowerCase().startsWith("application/json")) {
        return reply.code(415).send({ error: "use application/json" });
      }
    }
  });

  if (fs.existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  } else {
    app.log.warn("web dist not found at " + WEB_DIST + " - API only (run pnpm build or pnpm dev:web)");
  }
  return app;
}
