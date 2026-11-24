import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The dev *arr stub is the documented onboarding path (README "Try it in 30
// seconds"), so its per-item contract is pinned here: without GET /movie/:id,
// GET /episode/:id, GET /series/:id, the DELETE file endpoints and POST
// /command, every per-file action in the UI reads the stub's 404 as "the *arr
// no longer has this item" and deletes the row the user just clicked on.
const STUB = fileURLToPath(new URL("../dev/stub-arr.mjs", import.meta.url));
const KEY = "checkarr-stub-key";
const FIXTURES = ["healthy-movie.mp4", "truncated-movie.mp4", "healthy-ep.mkv", "damaged-ep.mkv"];

let child = null;
let mediaDir = "";
let radarr = "";
let sonarr = "";
let output = "";

function arrUrl(stdout, name) {
  const line = stdout.split("\n").find((l) => l.startsWith(name + " : http://"));
  if (line === undefined) return null;
  const url = line.slice(line.indexOf("http://")).split(" ")[0];
  return url.length > 0 ? url : null;
}

async function waitForUrls() {
  for (let i = 0; i < 400; i++) {
    radarr = arrUrl(output, "radarr") ?? "";
    sonarr = arrUrl(output, "sonarr") ?? "";
    if (radarr !== "" && sonarr !== "") return;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("stub-arr did not start:\n" + output);
}

/** Fetch as Checkarr would: with the stub's API key header. */
function arr(url, pathname, init = {}) {
  return fetch(url + pathname, {
    ...init,
    headers: { "x-api-key": KEY, ...(init.headers ?? {}) }
  });
}

beforeAll(async () => {
  mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "checkarr-stub-"));
  for (const f of FIXTURES) fs.writeFileSync(path.join(mediaDir, f), "0123456789");
  child = spawn(process.execPath, [STUB], {
    env: {
      ...process.env,
      CHECKARR_SAMPLE_MEDIA: mediaDir,
      // Ephemeral ports: the suite must not collide with a developer's
      // `pnpm stub:arr` (8699/8698) or with a second test run.
      CHECKARR_STUB_RADARR_PORT: "0",
      CHECKARR_STUB_SONARR_PORT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (c) => (output += String(c)));
  child.stderr.on("data", (c) => (output += String(c)));
  await waitForUrls();
});

afterAll(async () => {
  if (child !== null && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  if (mediaDir !== "") fs.rmSync(mediaDir, { recursive: true, force: true });
});

describe("dev *arr stub: Radarr per-item endpoints", () => {
  it("serves GET /api/v3/movie/:id with the file id Delete & re-search needs", async () => {
    const r = await arr(radarr, "/api/v3/movie/1");
    expect(r.status).toBe(200);
    const movie = await r.json();
    expect(movie).toMatchObject({ id: 1, title: "Sample Healthy Movie", year: 2023 });
    expect(typeof movie.movieFile.id).toBe("number");
    expect(movie.movieFile.path.endsWith("healthy-movie.mp4")).toBe(true);
  });

  it("answers 404 only for an id it does not track (the 'item removed' signal)", async () => {
    const r = await arr(radarr, "/api/v3/movie/999");
    expect(r.status).toBe(404);
  });

  it("accepts a queued command and answers with the command resource", async () => {
    const r = await arr(radarr, "/api/v3/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "MoviesSearch", movieIds: [1] })
    });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: 1, name: "MoviesSearch" });
  });

  it("rejects a request without the API key", async () => {
    const r = await fetch(radarr + "/api/v3/movie/1");
    expect(r.status).toBe(401);
  });
});

describe("dev *arr stub: Sonarr per-item endpoints", () => {
  it("serves GET /api/v3/episode/:id with the series and its episode file id", async () => {
    const r = await arr(sonarr, "/api/v3/episode/1?includeEpisodeFile=true");
    expect(r.status).toBe(200);
    const episode = await r.json();
    expect(episode).toMatchObject({ id: 1, seriesId: 1, seasonNumber: 1, episodeNumber: 1 });
    expect(typeof episode.episodeFileId).toBe("number");
    expect(episode.episodeFile.path.endsWith("healthy-ep.mkv")).toBe(true);
  });

  it("only embeds episodeFile when includeEpisodeFile=true (the real contract)", async () => {
    const r = await arr(sonarr, "/api/v3/episode/1");
    expect(r.status).toBe(200);
    const episode = await r.json();
    expect(episode.episodeFile).toBeNull();
  });

  it("serves GET /api/v3/series/:id so syncOneItem can title an episode", async () => {
    const r = await arr(sonarr, "/api/v3/series/1");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ id: 1, title: "Sample Show" });
  });

  it("accepts a queued command and answers with the command resource", async () => {
    const r = await arr(sonarr, "/api/v3/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "EpisodesSearch", episodeIds: [1] })
    });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ id: 1, name: "EpisodesSearch" });
  });
});

// Order matters: the delete tests mutate the in-memory library, which is what
// a re-sync must then report as a gap.
describe("dev *arr stub: deleting a file shows the gap", () => {
  it("DELETE /api/v3/moviefile/:id removes the file from the movie and the library list", async () => {
    const del = await arr(radarr, "/api/v3/moviefile/1001", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.text()).toBe("");

    const one = await (await arr(radarr, "/api/v3/movie/1")).json();
    expect(one.movieFile).toBeNull();
    const list = await (await arr(radarr, "/api/v3/movie")).json();
    expect(list.find((m) => m.id === 1).movieFile).toBeNull();
    // The item itself is still tracked: a sync parks the row as missing rather
    // than removing it.
    expect(list.find((m) => m.id === 1).monitored).toBe(true);
  });

  it("DELETE /api/v3/episodefile/:id removes the file from the episode", async () => {
    const del = await arr(sonarr, "/api/v3/episodefile/2002", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.text()).toBe("");

    const one = await (await arr(sonarr, "/api/v3/episode/2?includeEpisodeFile=true")).json();
    expect(one.episodeFile).toBeNull();
    expect(one.hasFile).toBe(false);
  });

  it("answers 404 for a file id it does not know", async () => {
    expect((await arr(radarr, "/api/v3/moviefile/424242", { method: "DELETE" })).status).toBe(404);
    expect((await arr(sonarr, "/api/v3/episodefile/424242", { method: "DELETE" })).status).toBe(404);
  });
});
