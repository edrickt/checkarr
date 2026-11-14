# Checkarr codebase map

Verified against the working tree after the 2026-11-13 UI overhaul (last commit `de2615f`). pnpm monorepo: a Fastify/TypeScript API on Node's built-in `node:sqlite` (`apps/server`), a React 19 + Vite + Tailwind UI (`apps/web`), and plain-Node desktop/tray launchers (`scripts/`). Start at `apps/server/src/index.ts`; the abstraction to learn first is the `ScanManager` in `apps/server/src/services/scanner.ts`.

Maintenance: after adding, moving, or deleting a source file, update the File index and bump `Verified against` to the commit you checked.

## Orientation

- Locally hosted media integrity checker for Radarr/Sonarr. It syncs the \*arr library into SQLite, decodes every file with ffmpeg (start, middle, end), and flags corrupt/suspect/missing/unreachable files. Optional Delete & re-search and Re-search missing queue replacements at the \*arr.
- Server entry: `apps/server/src/index.ts` opens the DB, resumes interrupted scans, builds Fastify via `apps/server/src/app.ts`, and listens on `127.0.0.1:5656`. It serves the built UI from `apps/web/dist` plus `/api` from `apps/server/src/routes.ts`.
- Core abstractions: `ScanManager` (`apps/server/src/services/scanner.ts:77`) owns run lifecycle, worker concurrency, cancellation and progress. `checkMediaFile` (`apps/server/src/services/checker.ts:130`) turns one file into a verdict. `syncSource` (`apps/server/src/services/sync.ts:318`) makes the DB mirror the \*arr.
- Derived dirs: `apps/server/dist` and `apps/web/dist` are build output; `data/` is gitignored runtime state (DB, logs, sample media); coverage output is generated.
- Domain docs: none in the CONTEXT/GLOSSARY/ADR sense. `PRODUCT.md` (product spec) and `DESIGN.md` (visual authority) exist at the repo root; read both before UI changes. `README.md` is the behaviour spec; `docs/audits/` is a historical audit.
- Errors: throw `ApiError` (`apps/server/src/lib/api-error.ts:1`); the handler registered in `apps/server/src/routes.ts` maps it to an HTTP status.
- The API is unauthenticated and meant for loopback/LAN use; security behaviour lives in `apps/server/src/app.ts`, not in route handlers.

## Layers

| Layer             | Path                                                                                | Owns                                         | Read when              |
| ----------------- | ----------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------- |
| HTTP/API          | `apps/server/src`                                                                   | startup, guards, `/api` endpoints, static UI | API work               |
| Scan engine       | `apps/server/src/services`, `apps/server/src/lib/classify.ts`                       | run lifecycle, probing/decoding, verdicts    | verdict or scan change |
| \*arr integration | `apps/server/src/services`                                                          | sync, delete + re-search, search missing     | library/sync/purge     |
| State and config  | `apps/server/src/db.ts`, `apps/server/src/settings.ts`, `apps/server/src/config.ts` | schema/migrations, settings, env             | DB or config work      |
| Web UI            | `apps/web/src`                                                                      | tabs, tables, modals, hash routing           | UI change              |
| Launchers         | `scripts/`                                                                          | start/stop, desktop, tray, dev fixtures      | scripts only           |

## Where things live

| Concern                                         | Files                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| API routes, validation, errors                  | `apps/server/src/routes.ts:114`                                                                                                            |
| Batch-operation gate (scan/sync/purge/research) | `apps/server/src/routes.ts:138`                                                                                                            |
| Host/cross-site guards                          | `apps/server/src/app.ts:90`                                                                                                                |
| DB schema, migrations, pragmas                  | `apps/server/src/db.ts:7`, `apps/server/src/db.ts:78`, `apps/server/src/db.ts:211`                                                         |
| Scan lifecycle, claims, progress                | `apps/server/src/services/scanner.ts:77`                                                                                                   |
| Per-file check (stat, probe, decode)            | `apps/server/src/services/checker.ts:130`                                                                                                  |
| ffmpeg resolution and PATH fallback             | `apps/server/src/services/ffmpeg.ts:116`, `apps/server/src/services/ffmpeg.ts:87`                                                          |
| Verdict classification                          | `apps/server/src/lib/classify.ts:25`, `apps/server/src/lib/classify.ts:46`                                                                 |
| \*arr HTTP client and sync                      | `apps/server/src/services/sync.ts:77`, `apps/server/src/services/sync.ts:318`                                                              |
| Purge, re-search missing                        | `apps/server/src/services/purge.ts:222`, `apps/server/src/services/research.ts:67`                                                         |
| Settings, path mappings                         | `apps/server/src/settings.ts:27`, `apps/server/src/lib/paths.ts:16`                                                                        |
| Env, paths, port, bind host                     | `apps/server/src/config.ts`                                                                                                                |
| Status/scope vocabulary                         | `apps/server/src/services/checker.ts:14`, `apps/web/src/status.ts:17`                                                                      |
| UI shell, dashboard actions                     | `apps/web/src/App.tsx:19`, `apps/web/src/components/Dashboard.tsx:58`                                                                      |
| Library, detail, settings                       | `apps/web/src/components/LibraryTable.tsx:47`, `apps/web/src/components/DetailModal.tsx:38`, `apps/web/src/components/SettingsPage.tsx:76` |
| Web plumbing (client, hooks, routing)           | `apps/web/src/api.ts:53`, `apps/web/src/hooks.ts:6`, `apps/web/src/router.ts:76`, `apps/web/src/useScan.ts:15`                             |
| Start/stop, desktop, tray                       | `scripts/`                                                                                                                                 |
| Dev fixtures                                    | `scripts/dev/gen-sample-media.mjs`, `scripts/dev/stub-arr.mjs`                                                                             |
| Packaging and CI                                | `docker/Dockerfile`, `docker/docker-compose.yml`, `.github/workflows/ci.yml`                                                               |

## Task recipes

**Add or change an API endpoint.** Read `apps/server/src/routes.ts:114` (routes, error handler) and `apps/server/src/app.ts:90` (guards apply to all). Change the handler; mirror the client call in `apps/web/src/api.ts:51`. Test `pnpm -F @checkarr/server exec vitest run test/routes.test.ts`.

**Change what counts as corrupt or suspect.** Read `apps/server/src/lib/classify.ts:25` (decode rules), `apps/server/src/lib/classify.ts:46` (probe rules) and `apps/server/src/services/checker.ts:130` (step order and thresholds). Test `pnpm -F @checkarr/server exec vitest run test/classify.test.ts` and, for real decoding, `apps/server/test/checker.integration.test.ts`.

**Add a file status or scan scope.** Update every copy: `apps/server/src/services/checker.ts:14`, `apps/server/src/services/scanner.ts:10`, `apps/server/src/routes.ts:535`, the CHECK constraints in `apps/server/src/db.ts:7` plus a migration at `apps/server/src/db.ts:78`, then `apps/web/src/types.ts:1` and `apps/web/src/status.ts:17`. Test `apps/server/test/migrate.test.ts`, `apps/server/test/scanner.test.ts` and `apps/web/test/status.test.ts`.

**Change library sync.** Read `apps/server/src/services/sync.ts:318` (path identity, relink, unfile, remove) and `apps/server/src/services/sync.ts:77` (HTTP/body handling). Test `pnpm -F @checkarr/server exec vitest run test/sync.test.ts`.

**Add a settings field.** Read `apps/server/src/settings.ts:27` (read/defaults) and `apps/server/src/settings.ts:55` (validation), the `settings` table in `apps/server/src/db.ts:7` plus a migration at `apps/server/src/db.ts:78`; wire the GET/PUT handlers near `apps/server/src/routes.ts:284`; add the control in `apps/web/src/components/SettingsPage.tsx:18`.

**Change UI tabs or deep links.** Read `apps/web/src/router.ts:76` (parse/serialize) and `apps/web/src/App.tsx:19` (tab shell). Test `pnpm -F @checkarr/web exec vitest run test/router.test.ts`.

**Change start/stop/tray behaviour.** Read `scripts/start.mjs`, `scripts/stop.mjs`, `scripts/lib/launcher.mjs` and `scripts/lib/tray.mjs`. Test `pnpm exec vitest run scripts/test/launcher.test.mjs`; the root vitest config covers `scripts/test/**/*.test.mjs`.

## Tests

- Server suites: `apps/server/test/` (vitest, config `apps/server/vitest.config.ts`). Layer coverage: `classify.test.ts`, `paths.test.ts`, `ffmpeg.test.ts`, `fetcharr.test.ts`, `sync.test.ts`, `purge.test.ts`, `scanner.test.ts`, `migrate.test.ts`, `host-guard.test.ts`. `routes.test.ts` is the HTTP/guards integration suite; `checker.integration.test.ts` encodes real media.
- Web suites: `apps/web/test/` (vitest + jsdom, setup `apps/web/test/setup.ts`, config `apps/web/vitest.config.ts`): `Dashboard`, `LibraryTable`, `SettingsPage`, `StatusBadge`, `Toast`, `ConfirmDialog`, `router`, `status`, `utils`.
- Script suites: `scripts/test/` (root `vitest.config.ts`): `command`, `desktop`, `icon`, `launcher`, `tray`. `command` checks the real `Checkarr.command` launcher; the rest use pure functions, temp dirs and `HOME` overrides.
- No fixture or golden directories. DB tests use `new DatabaseSync(":memory:")`; media tests build files in `fs.mkdtempSync` temp dirs. `pnpm gen:samples` writes sample media into the gitignored `data/` directory.
- Run everything: `pnpm test` (root script tests, then each workspace). One package: `pnpm -F @checkarr/server test` or `pnpm -F @checkarr/web test`. One file: `pnpm -F @checkarr/server exec vitest run test/classify.test.ts` or `pnpm exec vitest run scripts/test/launcher.test.mjs`.
- Naming: `*.test.ts` and `*.test.tsx` in the apps, `*.test.mjs` for scripts. The integration file still runs in the default server suite; it self-skips when the bundled ffmpeg cannot execute.
- Slow suite: `apps/server/test/checker.integration.test.ts` (real encode/decode). Everything else is fast; use single-file commands while iterating.

## Don't read

- `node_modules/`, `apps/server/node_modules/`, `apps/web/node_modules/`: installed dependencies.
- `apps/server/dist/`, `apps/web/dist/`: generated build output; edit the matching `apps/server/src/` or `apps/web/src/` tree instead.
- `data/`: gitignored runtime state (SQLite DB/WAL, server and launcher logs, tray files, sample media). Never hand-edit.
- Coverage output: generated by `pnpm test:coverage`; not source.
- `docs/audits/2026-11-08-code-quality-audit.md`: historical audit against an older commit; fix status and test counts are stale. Read only for history.
- `docs/assets/icon.png`, `docs/checkarr_demo.gif`: binary assets.
- `pnpm-lock.yaml`: generated lockfile; change it via pnpm, not by hand.
- README endpoint list: `apps/server/src/routes.ts` is the source of truth; the README can lag.

## Gotchas

- Node >= 23.4 is required: `apps/server/src/db.ts` imports `node:sqlite` (`DatabaseSync`), `package.json` declares `engines.node >=23.4`, and `.npmrc` sets `engine-strict=true`. CI uses Node 24.
- Schema changes are hand-rolled in `apps/server/src/db.ts`: `SCHEMA` (`apps/server/src/db.ts:7`) creates fresh installs, `migrate()` (`apps/server/src/db.ts:78`) patches older ones with idempotent `PRAGMA table_info` checks and table rebuilds. There is no migrations directory. A new column needs a SCHEMA edit, a migration branch, and a `migrate.test.ts` case.
- Status and scope vocabulary is duplicated: `apps/server/src/services/checker.ts:14`, `apps/server/src/services/scanner.ts:10`, `apps/server/src/routes.ts:535`, the DB CHECK constraints in `apps/server/src/db.ts:7`, `apps/web/src/types.ts:1`, `apps/web/src/status.ts:17`. Miss one and the app rejects or mislabels it. `healthy` is not a scan scope.
- `pnpm dev:server` serves the built UI from `apps/web/dist` on `127.0.0.1:5656`; it does not run Vite. For UI HMR run `pnpm dev:web` too (Vite on 5173, proxies `/api` to 5656 via `apps/web/vite.config.ts`). A stale `apps/web/dist` hides UI edits.
- The API has no authentication by design. Host and cross-site write checks are one `onRequest` hook in `apps/server/src/app.ts:90`, not per-route middleware. While broadcasting (`HOST=0.0.0.0`, Docker), Host checking is permissive unless `CHECKARR_ALLOWED_HOSTS` is set. Tests: `apps/server/test/host-guard.test.ts`, `apps/server/test/routes.test.ts`.
- Every batch operation (scan, sync, bulk purge, re-search) takes the gate at `apps/server/src/routes.ts:138` and syncs the \*arr first. New routes that touch the library must use that gate; per-file routes sync their one item first.
- Bundled `ffprobe-static` can ship the wrong CPU architecture on Apple Silicon; `chooseStaticBinary` (`apps/server/src/services/ffmpeg.ts:87`) falls back to a system binary on `PATH`. Do not hard-code binary paths to "fix" this.

## File index

`apps/server/src/`

- `apps/server/src/index.ts` - process entry: open DB, resume scans, listen.
- `apps/server/src/app.ts` - Fastify factory, static UI, guards, listener restart.
- `apps/server/src/routes.ts` - all `/api` endpoints, validation, batch gate, errors.
- `apps/server/src/config.ts` - env vars, repo paths, port, bind host.
- `apps/server/src/db.ts` - SCHEMA, migrations, WAL/pragma setup.
- `apps/server/src/settings.ts` - settings read/write, defaults, validation.
- `apps/server/src/lib/api-error.ts` - status-carrying error used by routes.
- `apps/server/src/lib/classify.ts` - decode/probe output to verdict rules.
- `apps/server/src/lib/paths.ts` - ordered prefix path-mapping rewrite.
- `apps/server/src/services/checker.ts` - one-file accessibility, probe, three decode checks.
- `apps/server/src/services/ffmpeg.ts` - binary resolution/fallback, process runner, ffprobe.
- `apps/server/src/services/scanner.ts` - `ScanManager`: claim, run, cancel, progress.
- `apps/server/src/services/sync.ts` - \*arr client, library sync, relink/remove rules.
- `apps/server/src/services/purge.ts` - delete at the \*arr, queue replacements.
- `apps/server/src/services/research.ts` - queue searches for missing items.
- `apps/server/scripts/debug-check.ts` - throwaway encoder/checker probe for local debugging.

`apps/web/src/`

- `apps/web/src/main.tsx` - React root, QueryClient, error boundary.
- `apps/web/src/App.tsx` - tab shell, header, scan progress, route dispatch.
- `apps/web/src/api.ts` - typed fetch client for `/api`.
- `apps/web/src/hooks.ts` - React Query hooks for stats, scan, sources, settings.
- `apps/web/src/useScan.ts` - optimistic scan start/cancel and polling gate.
- `apps/web/src/router.ts` - hash route parse/serialize and `useHashRoute`.
- `apps/web/src/status.ts` - canonical status order, labels, dot colors, scopes.
- `apps/web/src/types.ts` - shared domain and API types.
- `apps/web/src/utils.ts` - byte, duration and date formatting.
- `apps/web/src/index.css` - Tailwind entry and base styles.
- `apps/web/src/ui/icons.tsx` - authored inline SVG icon set (chevron, close, more, sort caret).
- `apps/web/src/components/Dashboard.tsx` - status cards and scan/purge/research actions.
- `apps/web/src/components/LibraryTable.tsx` - filter/sort/page table and row actions.
- `apps/web/src/components/DetailModal.tsx` - file detail, stream player, recheck.
- `apps/web/src/components/SettingsPage.tsx` - sources, binaries, mappings, broadcasting.
- `apps/web/src/components/StatusBadge.tsx` - status label and dot.
- `apps/web/src/ui/Button.tsx` - button primitive with variant and size.
- `apps/web/src/ui/controls.tsx` - Input/Select form control primitives.
- `apps/web/src/ui/ErrorBanner.tsx` - inline query-error banner.
- `apps/web/src/ui/Modal.tsx` - focus-trapping modal with nested-Escape stack.
- `apps/web/src/ui/ConfirmDialog.tsx` - promise-based confirm provider.
- `apps/web/src/ui/Menu.tsx` - portal dropdown menu.
- `apps/web/src/ui/Toast.tsx` - success/error toast provider.
- `apps/web/src/ui/Toggle.tsx` - accessibly labelled switch.

`scripts/`

- `scripts/start.mjs` - build, stop any instance, spawn detached server, wait, open UI.
- `scripts/stop.mjs` - stop server by pid file or port, stop tray.
- `scripts/launch.mjs` - desktop-icon entry: start if down, then open dashboard.
- `scripts/desktop.mjs` - install/uninstall the app-drawer icon.
- `scripts/tray.mjs` - tray start/stop/status control.
- `scripts/lib/launcher.mjs` - build staleness, port probe, browser open, wait loop.
- `scripts/lib/desktop.mjs` - per-OS bundle/shortcut install.
- `scripts/lib/tray.mjs` - per-OS tray host process.
- `scripts/lib/icon.mjs` - pure-Node icon/PNG/ICO rendering.
- `scripts/dev/gen-sample-media.mjs` - write healthy and damaged sample media.
- `scripts/dev/stub-arr.mjs` - fake Radarr on 8699 and Sonarr on 8698.

Root: `Checkarr.command` - macOS double-click launcher that runs `pnpm start`.
