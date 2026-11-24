import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkMediaFile } from "../src/services/checker.js";

// The confinement guard must run before any binary is spawned, so the binaries
// are deliberately unspawnable: a test that reaches ffmpeg fails loudly.
const BINARIES = { ffmpeg: "/nonexistent/ffmpeg", ffprobe: "/nonexistent/ffprobe" };

describe("checkMediaFile media-root confinement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkarr-confine-"));
  const media = path.join(root, "media");
  const outside = path.join(root, "outside");

  beforeAll(() => {
    fs.mkdirSync(media, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.txt"), "not media");
    fs.writeFileSync(path.join(media, "present.mkv"), "not really media either");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(media, "escape.mkv"));
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("reports a path outside the configured media roots as unreachable, without decoding it", async () => {
    const outcome = await checkMediaFile(path.join(outside, "secret.txt"), {
      binaries: BINARIES,
      mappings: [],
      mediaRoots: [media]
    });
    expect(outcome.status).toBe("unreachable");
    expect(outcome.detail).toMatch(/outside the configured media roots/);
    expect(outcome.probe).toBeNull();
  });

  it("reports a symlink that escapes a media root as unreachable", async () => {
    const outcome = await checkMediaFile(path.join(media, "escape.mkv"), {
      binaries: BINARIES,
      mappings: [],
      mediaRoots: [media]
    });
    expect(outcome.status).toBe("unreachable");
    expect(outcome.detail).toMatch(/outside the configured media roots/);
  });

  it("still reports a rooted path that is gone as missing (not unreachable)", async () => {
    const outcome = await checkMediaFile(path.join(media, "gone.mkv"), {
      binaries: BINARIES,
      mappings: [],
      mediaRoots: [media]
    });
    expect(outcome.status).toBe("missing");
    expect(outcome.detail).toContain("gone.mkv");
  });

  it("confines after the path mapping is applied", async () => {
    // The mapping rewrites the *arr path into a declared root: allowed. The
    // same reported path without the root would be refused (previous test).
    const outcome = await checkMediaFile("/movies/gone.mkv", {
      binaries: BINARIES,
      mappings: [{ match: "/movies", replace: media }],
      mediaRoots: [media]
    });
    expect(outcome.status).toBe("missing");
  });
});
