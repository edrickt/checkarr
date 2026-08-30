import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const media = path.join(root, "data", "sample-media");
const KEY = "checkarr-stub-key";

const required = ["healthy-movie.mp4", "truncated-movie.mp4", "healthy-ep.mkv", "damaged-ep.mkv"];
for (const f of required) {
  if (!fs.existsSync(path.join(media, f))) {
    console.error("missing " + f + " - run: pnpm gen:samples");
    process.exit(1);
  }
}

const size = (f) => fs.statSync(path.join(media, f)).size;

const movies = [
  {
    id: 1,
    title: "Sample Healthy Movie",
    year: 2023,
    movieFile: { path: path.join(media, "healthy-movie.mp4"), size: size("healthy-movie.mp4"), quality: { quality: { name: "WEBDL-1080p" } } }
  },
  {
    id: 2,
    title: "Sample Truncated Movie",
    year: 2024,
    movieFile: { path: path.join(media, "truncated-movie.mp4"), size: size("truncated-movie.mp4"), quality: { quality: { name: "WEBRip-720p" } } }
  },
  {
    id: 3,
    title: "Sample Ghost Movie",
    year: 2025,
    movieFile: { path: path.join(media, "ghost-movie.mp4"), size: 1, quality: { quality: { name: "Blu-ray-2160p" } } }
  }
];

const series = [{ id: 1, title: "Sample Show" }];

const episodes = [
  {
    id: 1,
    seriesId: 1,
    seasonNumber: 1,
    episodeNumber: 1,
    title: "Healthy Episode",
    hasFile: true,
    episodeFile: { path: path.join(media, "healthy-ep.mkv"), size: size("healthy-ep.mkv"), quality: { quality: { name: "HDTV-720p" } } }
  },
  {
    id: 2,
    seriesId: 1,
    seasonNumber: 1,
    episodeNumber: 2,
    title: "Damaged Episode",
    hasFile: true,
    episodeFile: { path: path.join(media, "damaged-ep.mkv"), size: size("damaged-ep.mkv"), quality: { quality: { name: "HDTV-720p" } } }
  }
];

// Route values are plain JSON bodies; functions handle the request themselves
// (used where the stub mimics real *arr validation, like /episode requiring seriesId).
function handler(appName, routes) {
  return (req, res) => {
    if (req.headers["x-api-key"] !== KEY) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const u = new URL(req.url ?? "/", "http://localhost");
    const route = routes[u.pathname];
    if (route === undefined) {
      res.writeHead(404).end("{}");
      return;
    }
    if (typeof route === "function") {
      route(req, res, u.searchParams);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(route));
  };
}

createServer(handler("Radarr", {
  "/api/v3/system/status": { appName: "Radarr", version: "5.14.0.9603" },
  "/api/v3/movie": movies
})).listen(8699, "127.0.0.1");

createServer(handler("Sonarr", {
  "/api/v3/system/status": { appName: "Sonarr", version: "4.0.9.2244" },
  "/api/v3/series": series,
  "/api/v3/episode": (req, res, q) => {
    // mirror the real API: bare /episode is a 400, and episodeFile only comes
    // along when includeEpisodeFile=true
    const sid = q.get("seriesId");
    if (sid === null) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ message: "seriesId or episodeIds must be provided" }));
      return;
    }
    const include = q.get("includeEpisodeFile") === "true";
    const list = episodes
      .filter((e) => String(e.seriesId) === sid)
      .map((e) => (include ? e : { ...e, episodeFile: null }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(list));
  }
})).listen(8698, "127.0.0.1");

console.log("radarr : http://127.0.0.1:8699  (api key: " + KEY + ")");
console.log("sonarr : http://127.0.0.1:8698  (api key: " + KEY + ")");
