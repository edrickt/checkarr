import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import { WEB_DIST } from "./config.js";
import { registerApi } from "./routes.js";
import { ScanManager } from "./services/scanner.js";
import type { DB } from "./db.js";

export async function buildApp(db: DB): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const scans = new ScanManager(db);
  registerApi(app, db, scans);
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
