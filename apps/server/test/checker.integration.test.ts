import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { checkMediaFile, decodeArgs } from "../src/services/checker.js";
import { progressShowsDecoding } from "../src/lib/classify.js";
import { binariesUsable, resolveBinaries, runBin, type Binaries } from "../src/services/ffmpeg.js";

const requireHere = createRequire(import.meta.url);

function bundledFfmpeg(): string | null {
  try {
    const p = requireHere("ffmpeg-static");
    return typeof p === "string" ? p : null;
  } catch {
    return null;
  }
}

const FF = bundledFfmpeg();

async function encode(args: string[]): Promise<void> {
  const r = await runBin(FF as string, args, 120_000);
  if (r.code !== 0) throw new Error("sample encode failed: " + r.stderr.slice(-400));
}

describe.skipIf(!FF)("checker integration (real ffmpeg)", () => {
  let dir: string;
  let binaries: Binaries;

  beforeAll(async () => {
    binaries = resolveBinaries({
      concurrency: 1,
      ffmpegPath: null,
      ffprobePath: null,
      pathMappings: [],
      localBroadcast: false
    });
    const problem = await binariesUsable(binaries);
    if (problem) throw new Error(problem);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkarr-test-"));

    const base = ["-nostdin", "-hide_banner", "-loglevel", "error"];
    const av = [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x120:rate=10:duration=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest"
    ];

    // healthy: faststart mp4, decodes end to end
    await encode([...base, "-y", ...av, "-movflags", "+faststart", path.join(dir, "healthy.mp4")]);

    // truncated: moov at the end, then cut to 40% -> container unparseable
    const truncPath = path.join(dir, "truncated.mp4");
    await encode([...base, "-y", ...av, truncPath]);
    const st = fs.statSync(truncPath);
    fs.truncateSync(truncPath, Math.floor(st.size * 0.4));

    // middle damage: faststart mp4 with zeroed bytes at 45-55% -> start decodes, middle fails
    const midPath = path.join(dir, "middle-damage.mp4");
    await encode([...base, "-y", ...av, "-movflags", "+faststart", midPath]);
    const buf = fs.readFileSync(midPath);
    buf.fill(0, Math.floor(buf.length * 0.45), Math.floor(buf.length * 0.55));
    fs.writeFileSync(midPath, buf);

    // tail damage: last 5% zeroed -> start and middle decode fine, only the
    // end check sees it. This is exactly what the end check exists for.
    const tailPath = path.join(dir, "tail-damage.mp4");
    await encode([...base, "-y", ...av, "-movflags", "+faststart", tailPath]);
    const tbuf = fs.readFileSync(tailPath);
    tbuf.fill(0, Math.floor(tbuf.length * 0.95));
    fs.writeFileSync(tailPath, tbuf);
  }, 240_000);

  it("marks a healthy file healthy", async () => {
    const r = await checkMediaFile(path.join(dir, "healthy.mp4"), { binaries, mappings: [] });
    expect(r.status).toBe("healthy");
    expect(r.detail).toBeNull();
    expect(r.probe?.durationS ?? 0).toBeGreaterThan(3);
  });

  it("marks a truncated file corrupt", async () => {
    const r = await checkMediaFile(path.join(dir, "truncated.mp4"), { binaries, mappings: [] });
    expect(r.status).toBe("corrupt");
    expect(r.detail).toBeTruthy();
  });

  it("catches damage in the middle via the middle check", async () => {
    const r = await checkMediaFile(path.join(dir, "middle-damage.mp4"), { binaries, mappings: [] });
    expect(["corrupt", "suspect"]).toContain(r.status);
    expect(r.detail).toBeTruthy();
  });

  it("catches damage near the end via the end check", async () => {
    const r = await checkMediaFile(path.join(dir, "tail-damage.mp4"), { binaries, mappings: [] });
    expect(["corrupt", "suspect"]).toContain(r.status);
    expect(r.detail).toContain("end (from");
  });

  it("reports missing files as missing", async () => {
    const r = await checkMediaFile(path.join(dir, "does-not-exist.mp4"), { binaries, mappings: [] });
    expect(r.status).toBe("missing");
  });

  it("applies path mappings before checking", async () => {
    const r = await checkMediaFile("/remote/movies/healthy.mp4", {
      binaries,
      mappings: [{ match: "/remote/movies", replace: dir }]
    });
    expect(r.status).toBe("healthy");
  });

  it("healthy decodes emit progress evidence (guards the no-decode rule)", async () => {
    const args = decodeArgs(path.join(dir, "healthy.mp4"), { seconds: 10, threads: 1 });
    const r = await runBin(binaries.ffmpeg, args, 90_000);
    expect(r.code).toBe(0);
    expect(progressShowsDecoding(r.stdout)).toBe(true);
  });

  it("a seek past EOF decodes nothing and must not read as a clean pass", async () => {
    const args = decodeArgs(path.join(dir, "healthy.mp4"), { seconds: 10, seekS: 60 });
    const r = await runBin(binaries.ffmpeg, args, 90_000);
    expect(r.code).toBe(0);
    expect(progressShowsDecoding(r.stdout)).toBe(false);
  });
});
