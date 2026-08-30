const NL = String.fromCharCode(10);

export type StepVerdict = "pass" | "suspect" | "fail";

export interface DecodeResult {
  /** Process exit code; meaningless when timedOut is true. */
  code: number;
  stderr: string;
  timedOut: boolean;
}

/**
 * Classify one ffmpeg decode attempt.
 *
 * With -v error, ffmpeg only prints error-level messages, so:
 *  - timed out              -> inconclusive (could be a slow disk) -> "suspect"
 *  - non-zero exit          -> decode failed hard -> "fail"
 *  - zero exit with stderr  -> recoverable errors (playback may glitch) -> "suspect"
 *  - zero exit, no stderr   -> "pass"
 */
export function classifyDecode(r: DecodeResult): StepVerdict {
  if (r.timedOut) return "suspect";
  if (r.code !== 0) return "fail";
  return r.stderr.trim().length > 0 ? "suspect" : "pass";
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
