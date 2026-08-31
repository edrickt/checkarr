const NL = String.fromCharCode(10);

export type StepVerdict = "pass" | "suspect" | "fail";

export interface DecodeResult {
  /** Process exit code; meaningless when timedOut is true. */
  code: number;
  stderr: string;
  timedOut: boolean;
  /** Signal name when the process died to a signal (OOM kill, manual kill);
   *  such a death says nothing about the file, so it is never "fail". */
  signaled?: string | null;
}

/**
 * Classify one ffmpeg decode attempt.
 *
 * With -v error, ffmpeg only prints error-level messages, so:
 *  - timed out              -> inconclusive (could be a slow disk) -> "suspect"
 *  - killed by a signal     -> inconclusive (OOM killer, admin kill) -> "suspect"
 *  - non-zero exit          -> decode failed hard -> "fail"
 *  - zero exit with stderr  -> recoverable errors (playback may glitch) -> "suspect"
 *  - zero exit, no stderr   -> "pass"
 */
export function classifyDecode(r: DecodeResult): StepVerdict {
  if (r.timedOut) return "suspect";
  if (r.signaled) return "suspect";
  if (r.code !== 0) return "fail";
  return r.stderr.trim().length > 0 ? "suspect" : "pass";
}

export interface ProbeFailure {
  /** ffprobe stderr (may be empty). */
  stderr: string;
  /** Set when the probe could not run at all (spawn error); null otherwise. */
  error: string | null;
}

/**
 * Classify a failed ffprobe run.
 *
 * Only ffprobe reporting "invalid data found when processing input" is proof
 * of corruption. A probe that merely times out (slow disk, network mount,
 * huge file) or fails for any other reason is inconclusive, not corrupt.
 */
export function classifyProbe(f: ProbeFailure): "corrupt" | "suspect" {
  return f.stderr.toLowerCase().includes("invalid data found when processing input") ? "corrupt" : "suspect";
}

const MAX_LINES = 6;
const MAX_LINE_CHARS = 240;
const MAX_TOTAL_CHARS = 1600;

/** Compact excerpt of ffmpeg stderr for storage in error_detail. */
export function excerpt(stderr: string): string {
  const lines = stderr
    .split(NL)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + "..." : l))
    .slice(-MAX_LINES);
  let out = lines.join(NL);
  if (out.length > MAX_TOTAL_CHARS) out = out.slice(0, MAX_TOTAL_CHARS) + "...";
  return out;
}

/**
 * ffmpeg's `-progress pipe:1` output: did anything actually get decoded?
 * Exit 0 with clean stderr can still mean zero frames (e.g. an input seek
 * past EOF when the container overstates its duration) - a "pass" without
 * decoded output is worthless, so callers treat it as inconclusive.
 */
export function progressShowsDecoding(progress: string): boolean {
  for (const line of progress.split(NL)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if ((key === "out_time_us" || key === "out_time_ms") && Number(value) > 0) return true;
    if (key === "frame" && Number(value) > 0) return true;
  }
  return false;
}

/** ffmpeg/ffprobe stderr that really means the file is gone, not corrupt. */
export function looksLikeMissing(stderr: string): boolean {
  return /no such file or directory/i.test(stderr);
}
