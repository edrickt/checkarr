import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { binariesUsable, resolveBinaries, runBin } from "../src/services/ffmpeg.js";
import { checkMediaFile } from "../src/services/checker.js";

async function main(): Promise<void> {
  const binaries = resolveBinaries({ concurrency: 1, ffmpegPath: null, ffprobePath: null, pathMappings: [] });
  const problem = await binariesUsable(binaries);
  console.log("binaries problem:", problem);
  if (problem) return;
  console.log("ffmpeg:", binaries.ffmpeg);
  console.log("ffprobe:", binaries.ffprobe);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkarr-debug-"));
  const file = path.join(dir, "healthy.mp4");
  const base = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  const av = ["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"];
  const enc = await runBin(binaries.ffmpeg, [...base, "-y", ...av, "-movflags", "+faststart", file], 120_000);
  console.log("encode code:", enc.code, "stderr:", JSON.stringify(enc.stderr.slice(-300)));
  console.log("file size:", fs.statSync(file).size);

  const outcome = await checkMediaFile(file, { binaries, mappings: [], mode: "quick" });
  console.log("outcome:", JSON.stringify(outcome, null, 2));
}

void main();
