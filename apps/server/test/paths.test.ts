import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPathMappings, resolveMediaPath } from "../src/lib/paths.js";

describe("applyPathMappings", () => {
  it("rewrites a matching prefix", () => {
    const mappings = [{ match: "/movies", replace: "/data/movies" }];
    expect(applyPathMappings("/movies/Big (2020)/file.mkv", mappings)).toBe(
      "/data/movies/Big (2020)/file.mkv"
    );
  });
  it("first match wins", () => {
    const mappings = [
      { match: "/movies", replace: "/first" },
      { match: "/movies", replace: "/second" }
    ];
    expect(applyPathMappings("/movies/file.mkv", mappings)).toBe("/first/file.mkv");
  });
  it("ignores non-matching paths", () => {
    const mappings = [{ match: "/movies", replace: "/data/movies" }];
    expect(applyPathMappings("/tv/show/file.mkv", mappings)).toBe("/tv/show/file.mkv");
  });
  it("respects prefix boundaries", () => {
    const mappings = [{ match: "/movies", replace: "/data/movies" }];
    expect(applyPathMappings("/movies2/file.mkv", mappings)).toBe("/movies2/file.mkv");
  });
  it("strips trailing slashes from rules", () => {
    const mappings = [{ match: "/movies/", replace: "/data/movies/" }];
    expect(applyPathMappings("/movies/file.mkv", mappings)).toBe("/data/movies/file.mkv");
  });
  it("handles an exact match", () => {
    const mappings = [{ match: "/movies", replace: "/data/movies" }];
    expect(applyPathMappings("/movies", mappings)).toBe("/data/movies");
  });
  it("rewrites windows-style paths to posix", () => {
    const mappings = [{ match: "E:/Movies", replace: "/Volumes/movies" }];
    expect(applyPathMappings("E:\\Movies\\Big (2020)\\file.mkv", mappings)).toBe(
      "/Volumes/movies/Big (2020)/file.mkv"
    );
  });
  it("accepts match rules written with backslashes", () => {
    const mappings = [{ match: "E:\\Movies", replace: "/Volumes/movies" }];
    expect(applyPathMappings("E:\\Movies\\Big (2020)\\file.mkv", mappings)).toBe(
      "/Volumes/movies/Big (2020)/file.mkv"
    );
  });
  it("respects prefix boundaries on normalized windows paths", () => {
    const mappings = [{ match: "E:/Movies", replace: "/Volumes/movies" }];
    expect(applyPathMappings("E:\\Movies2\\file.mkv", mappings)).toBe("E:\\Movies2\\file.mkv");
  });
  it("passes unmatched windows paths through unchanged", () => {
    const mappings = [{ match: "/movies", replace: "/data/movies" }];
    expect(applyPathMappings("D:\\TV Show\\s01e01.mkv", mappings)).toBe("D:\\TV Show\\s01e01.mkv");
  });
});

describe("resolveMediaPath", () => {
  // Real directories: the helper confines on fs.realpath, so symlink escapes
  // can only be tested against a real filesystem.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkarr-roots-"));
  const media = path.join(root, "media");
  const outside = path.join(root, "outside");

  beforeAll(() => {
    fs.mkdirSync(media, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(media, "a.mkv"), "a");
    fs.writeFileSync(path.join(outside, "secret.txt"), "s");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(media, "link.mkv"));
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("rewrites through a path mapping and returns the local path inside a root", async () => {
    const local = await resolveMediaPath("/movies/a.mkv", [{ match: "/movies", replace: media }], [media]);
    expect(local).toBe(fs.realpathSync(path.join(media, "a.mkv")));
  });

  it("refuses a path outside every configured media root", async () => {
    await expect(resolveMediaPath(path.join(outside, "secret.txt"), [], [media])).rejects.toMatchObject({
      code: "outside-media-roots"
    });
  });

  it("refuses a path whose mapping lands outside the roots", async () => {
    // A wrong mapping (match /movies, replace /) must not widen the boundary.
    await expect(
      resolveMediaPath("/movies/secret.txt", [{ match: "/movies", replace: root }], [media])
    ).rejects.toMatchObject({ code: "outside-media-roots" });
  });

  it("refuses a symlink inside a root that points outside it", async () => {
    // Without realpath, a symlink planted in the media folder would let the
    // stream endpoint (and ffmpeg) read anything the server user can read.
    await expect(resolveMediaPath(path.join(media, "link.mkv"), [], [media])).rejects.toMatchObject({
      code: "outside-media-roots"
    });
  });

  it("refuses relative paths and '..' segments", async () => {
    for (const reported of ["media/a.mkv", "../etc/passwd", media + "/../../etc/passwd", "a\0b"]) {
      await expect(resolveMediaPath(reported, [], [media])).rejects.toMatchObject({ code: "invalid-path" });
    }
  });

  it("allows any absolute path when no media root is configured (documented legacy)", async () => {
    // Installations upgraded from 1.1.x have no roots yet; the README tells
    // them to add one. With roots configured this path is refused above.
    expect(await resolveMediaPath(path.join(outside, "secret.txt"), [], [])).toBe(
      path.join(outside, "secret.txt")
    );
  });
});
