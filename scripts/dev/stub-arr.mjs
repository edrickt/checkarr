import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// The fixtures stay inside the repo for `pnpm stub:arr`; the spawn-based test
// points this at a temp dir so it never reads or writes the real data/ dir.
const media = process.env.CHECKARR_SAMPLE_MEDIA ?? path.join(root, "data", "sample-media");
const KEY = "checkarr-stub-key";
// Fixed ports for `pnpm stub:arr` (the README walkthrough); the test suite
// passes 0 for an ephemeral port so a developer's stub is never disturbed.
const RADARR_PORT = Number(process.env.CHECKARR_STUB_RADARR_PORT ?? 8699);
const SONARR_PORT = Number(process.env.CHECKARR_STUB_SONARR_PORT ?? 8698);

const required = ["healthy-movie.mp4", "truncated-movie.mp4", "healthy-ep.mkv", "damaged-ep.mkv"];
for (const f of required) {
  if (!fs.existsSync(path.join(media, f))) {
    console.error("missing " + f + " - run: pnpm gen:samples");
    process.exit(1);
  }
}

const size = (f) => fs.statSync(path.join(media, f)).size;

// Real *arr shape: a library item embeds its file object, which carries the
// file id the DELETE endpoints take. The dev flow's Delete & re-search needs
// that id, and so does a Re-check's GET /movie/:id.
const movies = [
  {
    id: 1,
    title: "Sample Healthy Movie",
    year: 2023,
    monitored: true,
    movieFile: {
      id: 1001,
      path: path.join(media, "healthy-movie.mp4"),
      size: size("healthy-movie.mp4"),
      quality: { quality: { name: "WEBDL-1080p" } }
    }
  },
  {
    id: 2,
    title: "Sample Truncated Movie",
    year: 2024,
    monitored: true,
    movieFile: {
      id: 1002,
      path: path.join(media, "truncated-movie.mp4"),
      size: size("truncated-movie.mp4"),
      quality: { quality: { name: "WEBRip-720p" } }
    }
  },
  {
    id: 3,
    title: "Sample Ghost Movie",
    year: 2025,
    monitored: true,
    movieFile: {
      id: 1003,
      path: path.join(media, "ghost-movie.mp4"),
      size: 1,
      quality: { quality: { name: "Blu-ray-2160p" } }
    }
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
    monitored: true,
    hasFile: true,
    episodeFileId: 2001,
    episodeFile: {
      id: 2001,
      path: path.join(media, "healthy-ep.mkv"),
      size: size("healthy-ep.mkv"),
      quality: { quality: { name: "HDTV-720p" } }
    }
  },
  {
    id: 2,
    seriesId: 1,
    seasonNumber: 1,
    episodeNumber: 2,
    title: "Damaged Episode",
    monitored: true,
    hasFile: true,
    episodeFileId: 2002,
    episodeFile: {
      id: 2002,
      path: path.join(media, "damaged-ep.mkv"),
      size: size("damaged-ep.mkv"),
      quality: { quality: { name: "HDTV-720p" } }
    }
  }
];

// Deleting a file at the *arr must show up in the library afterwards, exactly
// like the real API: the item stays, its file object goes away, and a re-sync
// reports the gap (Checkarr parks the row as missing).
function dropMovieFile(id) {
  const movie = movies.find(
    (m) => m.movieFile !== null && m.movieFile !== undefined && m.movieFile.id === id
  );
  if (!movie) return false;
  movie.movieFile = null;
  return true;
}

function dropEpisodeFile(id) {
  const episode = episodes.find((e) => e.episodeFile !== null && e.episodeFile.id === id);
  if (!episode) return false;
  episode.episodeFile = null;
  episode.episodeFileId = null;
  episode.hasFile = false;
  return true;
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

function empty(res, status) {
  res.writeHead(status).end();
}

// Route values are plain JSON bodies; functions handle the request themselves
// (used where the stub mimics real *arr validation, like /episode requiring
// seriesId). `dynamic` holds [RegExp, fn] pairs for the per-item endpoints.
function handler(appName, routes, dynamic = []) {
  return (req, res) => {
    if (req.headers["x-api-key"] !== KEY) {
      res
        .writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const u = new URL(req.url ?? "/", "http://localhost");
    const route = routes[u.pathname];
    if (route !== undefined) {
      if (typeof route === "function") {
        route(req, res, u.searchParams);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(route));
      return;
    }
    for (const [pattern, fn] of dynamic) {
      const match = pattern.exec(u.pathname);
      if (match !== null) {
        fn(req, res, match[1], u.searchParams);
        return;
      }
    }
    // A real *arr answers 404 for an item it does not track; Checkarr reads
    // that as "removed at the *arr" and drops the row, so it must be reserved
    // for genuinely unknown ids.
    res.writeHead(404, { "content-type": "application/json" }).end("{}");
  };
}

// Both *arrs answer a queued search with the command resource they created.
function command(req, res) {
  readBody(req).then((body) => {
    res
      .writeHead(201, { "content-type": "application/json" })
      .end(JSON.stringify({ id: 1, name: String(body?.name ?? "command") }));
  });
}

createServer(
  handler(
    "Radarr",
    {
      "/api/v3/system/status": { appName: "Radarr", version: "5.14.0.9603" },
      "/api/v3/movie": movies,
      "/api/v3/command": command
    },
    [
      [
        /^\/api\/v3\/movie\/(\d+)$/,
        (req, res, id) => {
          const movie = movies.find((m) => String(m.id) === id);
          if (movie === undefined) return empty(res, 404);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(movie));
        }
      ],
      [
        /^\/api\/v3\/moviefile\/(\d+)$/,
        (req, res, id) => {
          if (req.method !== "DELETE") return empty(res, 405);
          if (!dropMovieFile(Number(id))) return empty(res, 404);
          empty(res, 200);
        }
      ]
    ]
  )
).listen(RADARR_PORT, "127.0.0.1", function () {
  console.log("radarr : http://127.0.0.1:" + this.address().port + "  (api key: " + KEY + ")");
});

createServer(
  handler(
    "Sonarr",
    {
      "/api/v3/system/status": { appName: "Sonarr", version: "4.0.9.2244" },
      "/api/v3/series": series,
      "/api/v3/command": command,
      "/api/v3/episode": (req, res, q) => {
        // mirror the real API: bare /episode is a 400, and episodeFile only comes
        // along when includeEpisodeFile=true
        const sid = q.get("seriesId");
        if (sid === null) {
          res
            .writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ message: "seriesId or episodeIds must be provided" }));
          return;
        }
        const include = q.get("includeEpisodeFile") === "true";
        const list = episodes
          .filter((e) => String(e.seriesId) === sid)
          .map((e) => (include ? e : { ...e, episodeFile: null }));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(list));
      }
    },
    [
      [
        /^\/api\/v3\/episode\/(\d+)$/,
        (req, res, id, q) => {
          const episode = episodes.find((e) => String(e.id) === id);
          if (episode === undefined) return empty(res, 404);
          // Same contract as the collection endpoint: the file is embedded only
          // when includeEpisodeFile=true.
          const body = q.get("includeEpisodeFile") === "true" ? episode : { ...episode, episodeFile: null };
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
        }
      ],
      [
        /^\/api\/v3\/series\/(\d+)$/,
        (req, res, id) => {
          // syncOneItem re-reads the series for an episode's title/subtitle.
          const show = series.find((s) => String(s.id) === id);
          if (show === undefined) return empty(res, 404);
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(show));
        }
      ],
      [
        /^\/api\/v3\/episodefile\/(\d+)$/,
        (req, res, id) => {
          if (req.method !== "DELETE") return empty(res, 405);
          if (!dropEpisodeFile(Number(id))) return empty(res, 404);
          empty(res, 200);
        }
      ]
    ]
  )
).listen(SONARR_PORT, "127.0.0.1", function () {
  console.log("sonarr : http://127.0.0.1:" + this.address().port + "  (api key: " + KEY + ")");
});
