import fs from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { archAllowsBinary, chooseStaticBinary, pathBinary, resolveBinaries } from "../src/services/ffmpeg.js";

/** Minimal Mach-O header: magic + cputype. */
function macho(cpuType: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  buf.writeUInt32LE(cpuType, 4);
  return buf;
}

const X86_64 = 0x01000007;
const ARM64 = 0x0100000c;

describe("archAllowsBinary", () => {
  it("rejects a thin x86_64 binary on arm64 macOS", () => {
    expect(archAllowsBinary(macho(X86_64), "darwin", "arm64")).toBe(false);
  });

  it("accepts a thin arm64 binary on arm64 macOS", () => {
    expect(archAllowsBinary(macho(ARM64), "darwin", "arm64")).toBe(true);
  });

  it("accepts a thin x86_64 binary on x64 macOS (and under Rosetta)", () => {
    expect(archAllowsBinary(macho(X86_64), "darwin", "x64")).toBe(true);
  });

  it("rejects a thin arm64 binary on x64 macOS", () => {
    expect(archAllowsBinary(macho(ARM64), "darwin", "x64")).toBe(false);
  });

  it("never filters on other platforms (their bundled builds match)", () => {
    expect(archAllowsBinary(macho(X86_64), "linux", "arm64")).toBe(true);
    expect(archAllowsBinary(macho(ARM64), "win32", "x64")).toBe(true);
  });

  it("does not judge a header it cannot understand", () => {
    // Universal binary, unknown cputype, short/unreadable header: assume usable.
    const fat = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);
    expect(archAllowsBinary(fat, "darwin", "arm64")).toBe(true);
    expect(archAllowsBinary(Buffer.alloc(0), "darwin", "arm64")).toBe(true);
    expect(archAllowsBinary(Buffer.from("#!/bin/sh\n"), "darwin", "arm64")).toBe(true);
  });
});

describe("chooseStaticBinary (bundled vs PATH fallback)", () => {
  const deps = (allowsHost: boolean, fallback: string | null) => ({
    allowsHost: () => allowsHost,
    pathBinary: () => fallback
  });

  it("uses the bundled binary when it can run on this host", () => {
    expect(chooseStaticBinary("/bundle/ffmpeg", "ffmpeg", deps(true, "/usr/bin/ffmpeg"))).toBe(
      "/bundle/ffmpeg"
    );
  });

  it("falls back to a PATH binary when the bundled one cannot run here", () => {
    expect(
      chooseStaticBinary("/bundle/x86_64/ffprobe", "ffprobe", deps(false, "/opt/homebrew/bin/ffprobe"))
    ).toBe("/opt/homebrew/bin/ffprobe");
  });

  it("keeps the bundled binary when there is no PATH fallback (Rosetta may still run it)", () => {
    expect(chooseStaticBinary("/bundle/x86_64/ffprobe", "ffprobe", deps(false, null))).toBe(
      "/bundle/x86_64/ffprobe"
    );
  });

  it("returns null when nothing is bundled", () => {
    expect(chooseStaticBinary(null, "ffmpeg", deps(true, "/usr/bin/ffmpeg"))).toBeNull();
  });
});

const requireHere = createRequire(import.meta.url);

function bundledFfprobe(): string | null {
  try {
    const m = requireHere("ffprobe-static") as { path?: unknown } | null;
    return typeof m?.path === "string" ? m.path : null;
  } catch {
    return null;
  }
}

/** True when the bundled ffprobe exists but is built for another CPU. */
function bundledFfprobeIsWrongArch(): boolean {
  const file = bundledFfprobe();
  if (file === null || !fs.existsSync(file)) return false;
  try {
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(8);
    try {
      const read = fs.readSync(fd, head, 0, head.length, 0);
      return !archAllowsBinary(head.subarray(0, read));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

const wrongArchEnv =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  bundledFfprobeIsWrongArch() &&
  pathBinary("ffprobe") !== null;

describe("resolveBinaries", () => {
  it("keeps explicit settings paths as-is", () => {
    const binaries = resolveBinaries({
      concurrency: 8,
      ffmpegPath: "/custom/ffmpeg",
      ffprobePath: "/custom/ffprobe",
      pathMappings: [],
      localBroadcast: false
    });
    expect(binaries).toEqual({ ffmpeg: "/custom/ffmpeg", ffprobe: "/custom/ffprobe" });
  });

  // Real ffprobe-static@3.1.0 ships an x86_64 binary under bin/darwin/arm64/.
  // The environment-dependent guard is made explicit so the assertion can only
  // run where the setup it describes actually exists (and still fails pre-fix).
  it.skipIf(!wrongArchEnv)(
    "prefers a runnable system ffprobe over the wrong-architecture bundled one",
    () => {
      const binaries = resolveBinaries({
        concurrency: 8,
        ffmpegPath: null,
        ffprobePath: null,
        pathMappings: [],
        localBroadcast: false
      });
      expect(binaries.ffprobe).not.toContain("ffprobe-static");
      expect(binaries.ffprobe).toBe(pathBinary("ffprobe"));
    }
  );
});
