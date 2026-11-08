import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { migrate, type DB } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { applyLocalBroadcastSetting } from "../src/config.js";

function broadcastDb(): DB {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  db.prepare("UPDATE settings SET local_broadcast = 1").run();
  return db;
}

/**
 * When the server deliberately binds every interface, the Host check used to be
 * skipped entirely, so DNS rebinding worked in LAN/Docker mode and the
 * documented CHECKARR_ALLOWED_HOSTS was a no-op there. Configuring the
 * allowlist must actually enforce it.
 */
describe("Host guard under local broadcasting", () => {
  const previous = process.env.CHECKARR_ALLOWED_HOSTS;
  let enforced: FastifyInstance;
  let permissive: FastifyInstance;

  beforeAll(async () => {
    // The permissive app is built first, while the allowlist is unset.
    delete process.env.CHECKARR_ALLOWED_HOSTS;
    permissive = await buildApp(broadcastDb());
    process.env.CHECKARR_ALLOWED_HOSTS = "checkarr.lan";
    enforced = await buildApp(broadcastDb());
  });

  afterAll(async () => {
    await enforced.close();
    await permissive.close();
    applyLocalBroadcastSetting(false);
    if (previous === undefined) delete process.env.CHECKARR_ALLOWED_HOSTS;
    else process.env.CHECKARR_ALLOWED_HOSTS = previous;
  });

  const injectHost = (app: FastifyInstance, host: string) =>
    app.inject({ method: "GET", url: "/api/stats", headers: { host } });

  it("rejects a foreign Host while broadcasting when an allowlist is configured", async () => {
    expect((await injectHost(enforced, "evil.example")).statusCode).toBe(403);
    expect((await injectHost(enforced, "192.168.1.20:5656")).statusCode).toBe(403);
  });

  it("accepts configured and loopback hostnames while broadcasting", async () => {
    expect((await injectHost(enforced, "checkarr.lan:5656")).statusCode).toBe(200);
    expect((await injectHost(enforced, "localhost:5656")).statusCode).toBe(200);
    expect((await injectHost(enforced, "127.0.0.1:5656")).statusCode).toBe(200);
  });

  it("keeps the documented permissive default when no allowlist is configured", async () => {
    // LAN devices reach the UI by whatever address they use; without an
    // explicit allowlist the listener cannot know those hostnames.
    expect((await injectHost(permissive, "192.168.1.20:5656")).statusCode).toBe(200);
  });
});
