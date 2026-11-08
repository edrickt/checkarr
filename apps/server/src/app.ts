import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import { applyLocalBroadcastSetting, getBindHost, isBroadcastHost, PORT, WEB_DIST } from "./config.js";
import { registerApi, type ServerControl } from "./routes.js";
import { ScanManager } from "./services/scanner.js";
import { getSettings } from "./settings.js";
import type { DB } from "./db.js";

// Hostnames the UI may be opened on. The loopback bind alone is not a security
// boundary: without a Host check, DNS rebinding makes an attacker page
// same-origin with this API (API-key theft, media exfil, arbitrary file reads
// through re-written path mappings). In local-broadcast mode (HOST=0.0.0.0,
// Docker) the UI is reached by whatever LAN address the user opens, which the
// server cannot know; there hostname checking is only enabled when
// CHECKARR_ALLOWED_HOSTS lists the hostnames in use, and then it is enforced.
const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "::1", "[::1]"];

/** Extra hostnames from CHECKARR_ALLOWED_HOSTS (comma-separated). Read when the
 *  app is created, so a restart picks up a changed value. */
function envAllowedHostnames(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CHECKARR_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

export interface HostGuardPolicy {
  /** The address the listener is currently bound to (live setting). */
  bindHost: string;
  /** Hostnames accepted as this server (loopback + CHECKARR_ALLOWED_HOSTS). */
  allowed: ReadonlySet<string>;
  /** Check the list even while broadcasting; true when the allowlist is set. */
  enforceWhileBroadcasting: boolean;
}

export function requestHostAllowed(header: string | undefined, policy: HostGuardPolicy): boolean {
  if (header === undefined) return true; // HTTP/1.0-style clients
  // The bind host is a live setting (local broadcast), so the caller re-reads
  // it per request instead of freezing it at startup.
  const host = stripPort(header.toLowerCase());
  if (policy.allowed.has(host)) return true;
  // Broadcasting means the UI is opened on addresses this process cannot know.
  // Without a configured allowlist, keep the long-standing permissive default;
  // configuring CHECKARR_ALLOWED_HOSTS opts this deployment into enforcing it
  // (DNS-rebinding protection) while broadcasting too.
  if (isBroadcastHost(policy.bindHost) && !policy.enforceWhileBroadcasting) return true;
  return false;
}

function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const first = host.indexOf(":");
  const last = host.lastIndexOf(":");
  return first !== -1 && first === last ? host.slice(0, first) : host;
}

const MUTATING = new Set(["POST", "PUT", "DELETE", "PATCH"]);

async function createApp(db: DB, scans: ScanManager): Promise<FastifyInstance> {
  // forceCloseConnections: closing for a restart must not hang on idle
  // keep-alive browser sockets.
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, forceCloseConnections: true });
  const envHosts = envAllowedHostnames();
  const allowedHostnames = new Set([...LOOPBACK_HOSTNAMES, ...envHosts]);
  const hostPolicy: Omit<HostGuardPolicy, "bindHost"> = {
    allowed: allowedHostnames,
    enforceWhileBroadcasting: envHosts.length > 0
  };

  const serverControl: ServerControl = {
    bindHost: getBindHost,
    restart: async () => {
      // A closed Fastify instance cannot listen again, so build a fresh app
      // and swap it in. The old listener is torn down first to free the
      // port; the scan manager is shared so any running scan survives.
      const fresh = await createApp(db, scans);
      await app.close();
      // Re-read the toggle at restart time: a save may have landed since
      // startup, and this is the moment it takes effect.
      const host = applyLocalBroadcastSetting(getSettings(db).localBroadcast);
      await fresh.listen({ port: PORT, host });
    }
  };
  registerApi(app, db, scans, serverControl);

  app.addHook("onRequest", async (req, reply) => {
    if (!requestHostAllowed(req.headers.host, { ...hostPolicy, bindHost: getBindHost() })) {
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
      if (
        ct !== undefined &&
        !String(ct).split(";")[0]!.trim().toLowerCase().startsWith("application/json")
      ) {
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

export async function buildApp(db: DB): Promise<FastifyInstance> {
  const app = await createApp(db, new ScanManager(db));
  // Warm the bind host from settings so the first listen matches the toggle.
  applyLocalBroadcastSetting(getSettings(db).localBroadcast);
  return app;
}
