import { createRequire } from "node:module";
import fs from "node:fs";
import { spawn } from "node:child_process";
import type { AppSettings } from "../settings.js";

const requireFromHere = createRequire(import.meta.url);

function staticBinary(which: "ffmpeg" | "ffprobe"): string | null {
  try {
    if (which === "ffmpeg") {
      const p = requireFromHere("ffmpeg-static") as unknown;
      if (typeof p === "string" && fs.existsSync(p)) return p;
      return null;
    }
    const m = requireFromHere("ffprobe-static") as { path?: unknown } | null;
    const p = m && typeof m === "object" ? m.path : null;
    if (typeof p === "string" && fs.existsSync(p)) return p;
    return null;
  } catch {
    return null;
  }
}

export interface Binaries {
  ffmpeg: string;
  ffprobe: string;
}

/** Prefer explicit settings, then the bundled static binaries, then PATH. */
export function resolveBinaries(settings: AppSettings): Binaries {
  return {
    ffmpeg: settings.ffmpegPath || staticBinary("ffmpeg") || "ffmpeg",
    ffprobe: settings.ffprobePath || staticBinary("ffprobe") || "ffprobe"
  };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Signal name when the process died to a signal (SIGKILL, SIGTERM, ...);
   *  such a death says nothing about the media being checked. */
  signaled: string | null;
  /** Set when the process could not be spawned at all. */
  error: string | null;
}

const OUTPUT_CAP = 256 * 1024;

/** Run a binary to completion with a hard timeout (SIGTERM, then SIGKILL).
 *  An optional abort signal kills the process the same way, so a cancelled
 *  scan does not keep decoding files in the background. */
export function runBin(
  bin: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RunResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        code: -1,
        stdout: "",
        stderr: "",
        timedOut: false,
        signaled: null,
        error: "aborted before start"
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      // windowsHide keeps ffprobe/ffmpeg from flashing a console window per
      // check on Windows (maps to CREATE_NO_WINDOW); ignored on POSIX.
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({
        code: -1,
        stdout: "",
        stderr: "",
        timedOut: false,
        signaled: null,
        error: String((err as Error)?.message ?? err)
      });
      return;
    }
    let killTimer: NodeJS.Timeout | null = null;
    const killTree = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2000);
    };
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    const onAbort = (): void => killTree();
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code: number, error: string | null, signaled: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, signaled, error });
    };
    child.on("error", (err: Error) => finish(-1, err.message, null));
    // A null exit code means signal death (OOM killer, manual kill): record
    // which signal so classification can treat it as inconclusive, not fail.
    child.on("close", (code: number | null) => finish(code ?? -1, null, child.signalCode ?? null));
  });
}

export interface ProbeInfo {
  durationS: number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

export type ProbeResult = { ok: true; info: ProbeInfo } | { ok: false; stderr: string; error: string | null };

export async function ffprobeFile(
  bin: string,
  file: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ProbeResult> {
  const r = await runBin(
    bin,
    // note: ffprobe has no -nostdin flag (that is ffmpeg-only)
    ["-hide_banner", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    timeoutMs,
    signal
  );
  if (r.error) return { ok: false, stderr: r.stderr, error: r.error };
  if (r.timedOut)
    return {
      ok: false,
      stderr: r.stderr + String.fromCharCode(10) + "[checkarr] ffprobe timed out",
      error: null
    };
  if (r.code !== 0) return { ok: false, stderr: r.stderr, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    return {
      ok: false,
      stderr: "unparseable ffprobe output: " + String((err as Error)?.message ?? err),
      error: null
    };
  }
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as {
    format?: { duration?: unknown; format_name?: unknown };
    streams?: { codec_type?: unknown; codec_name?: unknown }[];
  };
  const fmt = obj.format ?? {};
  const streams = Array.isArray(obj.streams) ? obj.streams : [];
  const video = streams.find((s) => s && s.codec_type === "video");
  const audio = streams.find((s) => s && s.codec_type === "audio");
  let durationS: number | null = null;
  const rawDur = fmt.duration;
  if (typeof rawDur === "number" && Number.isFinite(rawDur)) durationS = rawDur;
  else if (typeof rawDur === "string" && rawDur !== "N/A" && rawDur.length > 0) {
    const n = Number(rawDur);
    if (Number.isFinite(n)) durationS = n;
  }
  return {
    ok: true,
    info: {
      durationS,
      container: typeof fmt.format_name === "string" ? fmt.format_name : null,
      videoCodec: video ? String(video.codec_name ?? null) : null,
      audioCodec: audio ? String(audio.codec_name ?? null) : null
    }
  };
}

/** Verify both binaries actually run; returns a problem description or null. */
export async function binariesUsable(b: Binaries): Promise<string | null> {
  const ff = await runBin(b.ffmpeg, ["-version"], 10_000);
  if (ff.error || ff.code !== 0) {
    return "ffmpeg is not runnable at: " + b.ffmpeg + (ff.error ? " (" + ff.error + ")" : "");
  }
  const fp = await runBin(b.ffprobe, ["-version"], 10_000);
  if (fp.error || fp.code !== 0) {
    return "ffprobe is not runnable at: " + b.ffprobe + (fp.error ? " (" + fp.error + ")" : "");
  }
  return null;
}
