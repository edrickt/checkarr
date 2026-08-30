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
  /** Set when the process could not be spawned at all. */
  error: string | null;
}

const OUTPUT_CAP = 256 * 1024;

/** Run a binary to completion with a hard timeout (SIGTERM, then SIGKILL). */
export function runBin(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
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
      resolve({ code: -1, stdout: "", stderr: "", timedOut: false, error: String((err as Error)?.message ?? err) });
      return;
    }
    child.stdout?.on("data", (d: Buffer) => { if (stdout.length < OUTPUT_CAP) stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { if (stderr.length < OUTPUT_CAP) stderr += d.toString("utf8"); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 2000);
    }, timeoutMs);
    const finish = (code: number, error: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, error });
    };
    child.on("error", (err: Error) => finish(-1, err.message));
    child.on("close", (code: number | null) => finish(code ?? -1, null));
  });
}

export interface ProbeInfo {
  durationS: number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

export type ProbeResult =
  | { ok: true; info: ProbeInfo }
  | { ok: false; stderr: string; error: string | null };

export async function ffprobeFile(bin: string, file: string, timeoutMs: number): Promise<ProbeResult> {
  const r = await runBin(
    bin,
    // note: ffprobe has no -nostdin flag (that is ffmpeg-only)
    ["-hide_banner", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    timeoutMs
  );
  if (r.error) return { ok: false, stderr: r.stderr, error: r.error };
  if (r.timedOut) return { ok: false, stderr: r.stderr + String.fromCharCode(10) + "[checkarr] ffprobe timed out", error: null };
  if (r.code !== 0) return { ok: false, stderr: r.stderr, error: null };
  let parsed: any;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (err) {
    return { ok: false, stderr: "unparseable ffprobe output: " + String((err as Error)?.message ?? err), error: null };
  }
  const fmt = (parsed && typeof parsed === "object" ? parsed.format : null) ?? {};
  const streams: any[] = Array.isArray(parsed?.streams) ? parsed.streams : [];
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
