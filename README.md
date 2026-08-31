# Checkarr

A locally hosted media integrity checker for Radarr and Sonarr libraries. Checkarr syncs your
library, then automatically verifies that every movie and episode file actually plays: it opens
the file, decodes the first few seconds, then scrubs to the middle of the file and decodes there.
Anything that fails shows up flagged on the dashboard.

## How it works

Browsers can only decode a handful of codecs, so Checkarr uses ffmpeg as the "player":
ffprobe parses the container, then ffmpeg decodes the video and audio streams into the null muxer.

- **Start check** - decode the first 10 seconds of every stream ("open it and play it")
- **Middle check** - input-seek to 50% of the duration and decode 10 seconds ("scrub to the middle")

Verdicts:

| Status      | Meaning                                                   |
| ----------- | --------------------------------------------------------- |
| healthy     | probe + all decode checks clean                           |
| corrupt     | container unparseable or a decode check failed            |
| suspect     | recoverable decode errors, unknown duration, or a timeout |
| missing     | the *arr library references a file that no longer exists  |
| unreachable | the file exists but is not readable (permissions)         |
| unchecked   | synced but not checked yet                                |

Checkarr keeps the ffmpeg findings per file, so you can see exactly what the decoder reported.

## Quick start (dev)

Requires Node 23.4+ (node:sqlite) and pnpm 11. ffmpeg and ffprobe come from
ffmpeg-static / ffprobe-static, so they download during pnpm install.

    pnpm install
    pnpm dev:server        # API + UI on http://127.0.0.1:5656
    pnpm dev:web           # optional: Vite dev server with HMR on http://localhost:5173

Open http://127.0.0.1:5656, go to Settings, add your Radarr/Sonarr instance (URL + API key),
test it, then hit "Sync libraries" on the Dashboard and start a scan.

### Try it without a real *arr instance

    pnpm gen:samples       # writes healthy/truncated/damaged sample files to data/sample-media
    pnpm stub:arr          # fake Radarr on :8699, fake Sonarr on :8698, api key: checkarr-stub-key

Add http://127.0.0.1:8699 / http://127.0.0.1:8698 as sources with that API key, sync, and scan:
you should get 2 healthy, 1 corrupt (truncated), 1 suspect (middle damage), 1 missing (ghost file).

## Production build

    pnpm build
    pnpm start             # serves the API and the built UI on http://127.0.0.1:5656

Or run it in the background:

    pnpm start             # builds, kills any running instance, starts fresh, waits until healthy
    pnpm stop              # stops it again

Both scripts are plain Node, so they work on macOS, Linux, and Windows (no WSL needed).
The background server logs to data/server.log and writes its pid to data/checkarr.pid.
CHECKARR_PORT/PORT are honored by both scripts. Foreground die-hards: pnpm -F @checkarr/server start.

## Docker

    cd docker
    docker compose up -d --build

Mount your media into the container and add path mappings in Checkarr settings
(e.g. match /movies -> /data/movies) when the *arr-reported paths differ from the container paths.

## Configuration

Settings live in SQLite (data/checkarr.db, override the directory with CHECKARR_DATA_DIR):

- **Sources** - Radarr/Sonarr base URL + API key (Settings > General in the *arr web UI)
- **Path mappings** - ordered prefix rewrites from *arr paths to local paths
- **Concurrent checks** - 1-32 parallel ffmpeg workers (default 8)
- **ffmpeg/ffprobe path overrides** - use system binaries instead of the bundled ones

Environment: CHECKARR_PORT (default 5656; 6767 belongs to Bazarr), HOST (default 127.0.0.1), CHECKARR_DATA_DIR,
CHECKARR_WEB_DIST, LOG_LEVEL.

## API

    GET    /api/stats                     counts by status and by source + last scan
    GET    /api/settings                  settings + resolved binaries
    PUT    /api/settings                  update settings (concurrency, paths, mappings)
    GET    /api/sources                   list sources
    POST   /api/sources                   { type, name, baseUrl, apiKey }
    PUT    /api/sources/:id               update source
    DELETE /api/sources/:id               delete source and its files
    POST   /api/sources/:id/test          verify URL + key (GET /api/v3/system/status)
    POST   /api/sync                      pull libraries from all enabled sources (or { sourceId })
    POST   /api/scan                      { scope: unchecked|all, sourceId? }
    POST   /api/purge                     { status: corrupt|suspect|all, sourceId? } delete files at the *arr source(s) + search replacements
    POST   /api/files/:id/purge           delete one file at its *arr source + search replacement
    POST   /api/scan/cancel               stop the running scan
    GET    /api/scan/current              progress of the active/last run
    GET    /api/files?status=&sourceId=&q=&page=    library listing
    GET    /api/files/:id                 full detail incl. ffmpeg findings
    POST   /api/files/:id/recheck         re-run the quick check on one file
    GET    /api/files/:id/stream          Range-aware streaming for the browser player

## Notes and assumptions

- Checkarr is a read-only *arr client: it never modifies Radarr/Sonarr data.
- The server binds to 127.0.0.1 by default and has no authentication - don't expose it to the
  internet as-is.
- API keys sit in the local database as plaintext.
- A scan checks every file independently; killing the server mid-scan leaves remaining files
  unchecked, and the next scan (scope "unchecked") picks them up.
- Files with no known duration never come back healthy: the middle check can't run, so
  suspect is the best possible verdict.

## Development

    pnpm test              # vitest: unit + ffmpeg integration + sync tests
    pnpm -F @checkarr/server dev
    pnpm -F @checkarr/web dev

Layout:

    apps/server   Fastify API, SQLite (node:sqlite), scan engine (TypeScript)
    apps/web      React + Vite + Tailwind UI
    scripts/dev   sample media generator + stub Radarr/Sonarr for local testing
    docker        Dockerfile + compose file
