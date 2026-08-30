import fs from "node:fs";
import { applyPathMappings } from "../lib/paths.js";
import { classifyDecode, excerpt, type StepVerdict } from "../lib/classify.js";
import { ffprobeFile, runBin, type Binaries, type ProbeInfo } from "./ffmpeg.js";
import type { PathMapping } from "../settings.js";

export type FileStatus = "unchecked" | "healthy" | "suspect" | "corrupt" | "missing" | "unreachable";
export type ScanMode = "quick" | "deep";

export interface CheckContext {
  binaries: Binaries;
  mappings: PathMapping[];
  mode: ScanMode;
  /** Decoder thread budget per ffmpeg process; keeps N workers inside the box's cores. */
  threads?: number;
}

export interface CheckOutcome {
  status: FileStatus;
  detail: string | null;
  probe: ProbeInfo | null;
}

const TIMEOUTS = { probeMs: 30_000, segmentMs: 90_000, deepMs: 1_800_000 };
const NL = String.fromCharCode(10);

export function resolveLocalPath(originalPath: string, mappings: PathMapping[]): string {
  return applyPathMappings(originalPath, mappings);
}

interface Step {
  name: string;
  verdict: StepVerdict;
  detail: string | null;
}

/**
 * The machine equivalent of "open the file and play it":
 * decode every video/audio stream into the null muxer.
 * seekS performs an input seek first (like a player scrub); seconds limits how much is decoded.
 */
// Guards against corrupted files that declare insane dimensions or make
  // ffmpeg allocate absurd buffers before decoding anything. Real media
  // (up to 8K, ~33.5M pixels) sails under both limits; damaged files fail
  // fast with an allocation error instead of eating gigabytes of RAM.
const MAX_PIXELS = String(33_554_432);
const MAX_ALLOC = String(1024 * 1024 * 1024);

function decodeArgs(file: string, opts: { seconds?: number; seekS?: number; threads?: number }): string[] {
  const args = ["-nostdin", "-hide_banner", "-v", "error", "-max_pixels", MAX_PIXELS, "-max_alloc", MAX_ALLOC];
  // ffmpeg decodes as fast as it can with up to ~16 threads per process by
  // default, which oversubscribes the CPU and starves everything else.
  // Budgeting threads per worker keeps the machine responsive.
  if (opts.threads !== undefined && opts.threads > 0) args.push("-threads", String(opts.threads));
  if (opts.seekS !== undefined) args.push("-ss", String(opts.seekS));
  if (opts.seconds !== undefined) args.push("-t", String(opts.seconds));
  args.push("-i", file, "-map", "0:v?", "-map", "0:a?", "-f", "null", "-");
  return args;
}

async function runDecodeStep(
  bin: string,
  file: string,
  name: string,
  opts: { seconds?: number; seekS?: number; threads?: number },
  timeoutMs: number
): Promise<Step> {
  const r = await runBin(bin, decodeArgs(file, opts), timeoutMs);
  if (r.error) return { name, verdict: "suspect", detail: name + ": could not run ffmpeg: " + r.error };
  const v = classifyDecode({ code: r.code, stderr: r.stderr, timedOut: r.timedOut });
  if (v === "pass") return { name, verdict: "pass", detail: null };
  if (v === "fail") {
    return { name, verdict: "fail", detail: name + " failed (exit " + r.code + "):" + NL + excerpt(r.stderr) };
  }
  const why = r.timedOut ? " timed out" : " reported recoverable errors:";
  return { name, verdict: "suspect", detail: name + why + NL + excerpt(r.stderr) };
}

const RANK: Record<StepVerdict, number> = { pass: 0, suspect: 1, fail: 2 };

/**
 * Full per-file check: accessibility, container probe, then decode tests.
 * quick = first 10 seconds + 10 seconds from the middle (50% of duration).
 * deep  = complete decode of every stream.
 */
export async function checkMediaFile(originalPath: string, ctx: CheckContext): Promise<CheckOutcome> {
  const localPath = resolveLocalPath(originalPath, ctx.mappings);

  // 1. Accessibility
  try {
    const st = await fs.promises.stat(localPath);
    if (!st.isFile()) return { status: "missing", detail: "Not a regular file: " + localPath, probe: null };
    await fs.promises.access(localPath, fs.constants.R_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { status: "missing", detail: "File not found: " + localPath, probe: null };
    if (code === "EACCES" || code === "EPERM") {
      return { status: "unreachable", detail: "Permission denied: " + localPath, probe: null };
    }
    return { status: "unreachable", detail: "Cannot access file: " + String((err as Error)?.message ?? err), probe: null };
  }

  // 2. Probe the container
  const probe = await ffprobeFile(ctx.binaries.ffprobe, localPath, TIMEOUTS.probeMs);
  if (!probe.ok) {
    const why = probe.error ? " (could not run ffprobe: " + probe.error + ")" : "";
    return {
      status: "corrupt",
      detail: "probe: container could not be parsed" + why + NL + excerpt(probe.stderr),
      probe: null
    };
  }
  const info = probe.info;

  // 3. Decode checks
  const steps: Step[] = [];
  if (ctx.mode === "deep") {
    steps.push(await runDecodeStep(ctx.binaries.ffmpeg, localPath, "full decode", { threads: ctx.threads }, TIMEOUTS.deepMs));
  } else {
    const start = await runDecodeStep(ctx.binaries.ffmpeg, localPath, "start (first 10s)", { seconds: 10, threads: ctx.threads }, TIMEOUTS.segmentMs);
    steps.push(start);
    const dur = info.durationS;
    if (start.verdict !== "fail" && dur !== null && dur > 0) {
      const mid = Math.max(0, Math.floor(dur / 2));
      steps.push(await runDecodeStep(ctx.binaries.ffmpeg, localPath, "middle (from " + mid + "s, 10s)", { seconds: 10, seekS: mid, threads: ctx.threads }, TIMEOUTS.segmentMs));
    } else if (start.verdict !== "fail" && (dur === null || dur <= 0)) {
      steps.push({ name: "middle", verdict: "suspect", detail: "middle check skipped: duration unknown" });
    }
  }

  // 4. Combine verdicts
  let worst: StepVerdict = "pass";
  for (const s of steps) if (RANK[s.verdict] > RANK[worst]) worst = s.verdict;
  const status: FileStatus = worst === "pass" ? "healthy" : worst === "suspect" ? "suspect" : "corrupt";
  const problems = steps.filter((s) => s.verdict !== "pass");
  const detail = problems.length === 0 ? null : problems.map((s) => s.detail ?? s.name).join(NL + NL);
  return { status, detail, probe: info };
}
