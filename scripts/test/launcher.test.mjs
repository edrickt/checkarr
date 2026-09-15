import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { browserCommand, isCheckarrStats, needsBuild, waitForServer } from "../lib/launcher.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkarr-repo-"));
  roots.push(root);
  const write = (rel, at) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
    if (at) fs.utimesSync(file, new Date(at), new Date(at));
  };
  const build = (at) => {
    write("apps/server/dist/index.js", at);
    write("apps/web/dist/index.html", at);
  };
  return { root, write, build };
}

describe("needsBuild", () => {
  it("asks for a build when the built UI or server is missing", () => {
    const { root, write } = makeRepo();
    write("apps/server/src/index.ts", 1000);
    expect(needsBuild(root)).toBe(true);
  });

  it("leaves a fresh build alone", () => {
    const { root, write, build } = makeRepo();
    write("apps/server/src/index.ts", 1000);
    write("apps/web/src/main.tsx", 1000);
    build(2000);
    expect(needsBuild(root)).toBe(false);
  });

  it("rebuilds when a source file is newer than the build", () => {
    const { root, write, build } = makeRepo();
    write("apps/server/src/index.ts", 1000);
    write("apps/web/src/main.tsx", 1000);
    build(2000);
    write("apps/web/src/App.tsx", 3000);
    expect(needsBuild(root)).toBe(true);
  });

  it("rebuilds when the lockfile changed", () => {
    const { root, write, build } = makeRepo();
    write("apps/server/src/index.ts", 1000);
    build(2000);
    write("pnpm-lock.yaml", 3000);
    expect(needsBuild(root)).toBe(true);
  });
});

describe("isCheckarrStats", () => {
  it("recognizes the /api/stats response shape", () => {
    expect(
      isCheckarrStats({ total: 3, byStatus: { healthy: 2, corrupt: 1 }, bySource: [], activeScan: false })
    ).toBe(true);
  });

  it("rejects anything else that answers on the port", () => {
    expect(isCheckarrStats(null)).toBe(false);
    expect(isCheckarrStats({ hello: "world" })).toBe(false);
    expect(isCheckarrStats({ total: "3", byStatus: {} })).toBe(false);
    expect(isCheckarrStats("<html><body>hi</body></html>")).toBe(false);
  });
});

describe("waitForServer", () => {
  const url = "http://127.0.0.1:5656/api/stats";

  it("returns true as soon as the health probe answers", async () => {
    const clock = { t: 0 };
    let attempts = 0;
    const fetchImpl = () => {
      attempts++;
      if (attempts < 3) return Promise.reject(new Error("connection refused"));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ total: 0, byStatus: { healthy: 0 } })
      });
    };
    const ok = await waitForServer(url, {
      timeoutMs: 5000,
      intervalMs: 100,
      now: () => clock.t,
      sleep: (ms) => {
        clock.t += ms;
      },
      fetchImpl
    });
    expect(ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it("gives up at the deadline", async () => {
    const clock = { t: 0 };
    const fetchImpl = () => Promise.reject(new Error("connection refused"));
    const ok = await waitForServer(url, {
      timeoutMs: 1000,
      intervalMs: 100,
      now: () => clock.t,
      sleep: (ms) => {
        clock.t += ms;
      },
      fetchImpl
    });
    expect(ok).toBe(false);
  });
});

describe("browserCommand", () => {
  it("uses the platform's URL opener", () => {
    expect(browserCommand("darwin", "http://127.0.0.1:5656")).toEqual({
      cmd: "open",
      args: ["http://127.0.0.1:5656"]
    });
    expect(browserCommand("linux", "http://127.0.0.1:5656")).toEqual({
      cmd: "xdg-open",
      args: ["http://127.0.0.1:5656"]
    });
    expect(browserCommand("win32", "http://127.0.0.1:5656")).toEqual({
      cmd: "cmd",
      args: ["/c", "start", "", "http://127.0.0.1:5656"]
    });
  });

  it("refuses platforms it does not know", () => {
    expect(() => browserCommand("sunos", "http://127.0.0.1:5656")).toThrow(/unsupported/i);
  });
});
