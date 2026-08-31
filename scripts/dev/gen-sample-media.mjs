import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const requireServer = createRequire(new URL("../../apps/server/package.json", import.meta.url));
let ffmpeg = process.env.FFMPEG_PATH;
if (!ffmpeg) {
  try {
    ffmpeg = requireServer("ffmpeg-static");
  } catch {
    // fall through
  }
}
if (!ffmpeg) {
  console.error("no ffmpeg available (set FFMPEG_PATH)");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = path.join(root, "data", "sample-media");
fs.mkdirSync(dir, { recursive: true });

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg exit " + code))));
  });
}

const AV = [
  "-f",
  "lavfi",
  "-i",
  "testsrc=size=320x240:rate=12:duration=6",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:duration=6",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-c:a",
  "aac",
  "-shortest"
];

// 1. healthy movie (faststart mp4)
await run([
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  ...AV,
  "-movflags",
  "+faststart",
  path.join(dir, "healthy-movie.mp4")
]);

// 2. truncated movie (moov at the end, cut to 40%)
const truncPath = path.join(dir, "truncated-movie.mp4");
await run(["-hide_banner", "-loglevel", "error", "-y", ...AV, truncPath]);
const st = fs.statSync(truncPath);
fs.truncateSync(truncPath, Math.floor(st.size * 0.4));

// 3. healthy episode (mkv)
await run(["-hide_banner", "-loglevel", "error", "-y", ...AV, path.join(dir, "healthy-ep.mkv")]);

// 4. damaged episode (mkv with zeroed middle bytes)
const ep2 = path.join(dir, "damaged-ep.mkv");
await run(["-hide_banner", "-loglevel", "error", "-y", ...AV, ep2]);
const buf = fs.readFileSync(ep2);
buf.fill(0, Math.floor(buf.length * 0.45), Math.floor(buf.length * 0.55));
fs.writeFileSync(ep2, buf);

console.log("sample media ready in " + dir);
