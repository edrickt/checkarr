# Checkarr code-quality & feature-reliability audit — 2026-11-12

- **Repository:** `/Users/etm1air/Files/Github/checkarr` (pnpm monorepo: Fastify/TypeScript/SQLite server + React 19/Vite/Tailwind web UI + plain-Node launcher scripts)
- **Baseline commit:** `ec361bd659fd0f0d0f41bb0aa7883f12896fdeaa` (`docs: add codebase map for agent exploration`, clean working tree at audit start; code identical to the `v1.1.1` release `d7c9acd`)
- **Environment:** macOS 26.0.1 arm64, Node v24.21.0, pnpm 11.7.0
- **Audit date:** 2026-11-12 (America/Detroit)
- **Release version:** pending — the Lead's release phase follows independent verification; the audit itself did not touch version files.
- **Prior audit report:** `docs/audits/2026-11-08-code-quality-audit.md` (baseline `5d0c06b`; its fixes are in `76089e6`)

## Scope

Whole repository: `README.md`, `AGENTS.md`, `docs/agents/codebase-map.md`, root/app `package.json`s,
all of `apps/server/src/**` including `apps/server/scripts/debug-check.ts`, all of `apps/web/src/**`,
`scripts/**` (start/stop/launch/desktop/tray + `scripts/lib/**` + `scripts/dev/**`), `docker/**`,
`.github/workflows/ci.yml`, both vitest configs, tsconfigs, eslint/prettier config, `Checkarr.command`, and
every existing test. Feature surface audited: scan lifecycle, library sync from Radarr/Sonarr, per-file
checker (ffprobe/ffmpeg classification), purged/replacement handling, purge, re-search, DB schema/migrations,
settings/config/env, HTTP routes + error mapping, host/cross-site guards, web UI (dashboard, library table,
detail modal, settings, scan hooks, hash router, UI primitives), desktop/tray/service scripts, Docker, CI.
`node_modules/`, `dist/`, `data/` and `pnpm-lock.yaml` were skipped as the codebase map directs; the prior
audit report was read only as the format/quality reference (its finding and test counts are historical).

## Method

1. Read `AGENTS.md`, `docs/agents/codebase-map.md`, the README behaviour spec ("How it works", "Verdicts",
   "Security"), the previous audit report and its fix commit `76089e6`, then every source file
   (≈8.2k LOC in scope) and every existing test to learn intended behaviour and coverage gaps.
2. Confirmed the untouched baseline was green from the repo root: `pnpm lint`, `pnpm format:check`,
   `pnpm typecheck`, `pnpm test` (**237 tests**: scripts 50, server 152, web 35, 0 skipped) and `pnpm build`
   (web dist JS 289.81 kB, 94 modules).
3. Hunted defects by code review plus targeted runtime probes in throwaway processes: Fastify
   `app.inject` against in-memory SQLite, temporary stub Radarr servers (including deliberately
   wrong-shaped 200 responses and same-path replacement downloads), and the real bundled ffmpeg. The real
   `data/` directory, real \*arr credentials and long-lived servers were never used.
4. For each accepted finding: wrote the regression test first, ran it against the unmodified source and
   observed it fail (10 failing tests across the five code findings; 2 more for the round-2 follow-ups
   below), then fixed minimally and confirmed the full suite green. The docs findings are verified by
   inspection.
5. Re-ran the full official gates, then an end-to-end HTTP probe of all five code fixes (sync → purge →
   same-path replacement resync → malicious/malformed request shapes) against the fixed source.

## Findings

| #   | Severity | Confidence | Location (post-fix)                                                     | Finding / impact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Fix                                                                                                                                                                                                                                                                                                                     | Regression test                                                                                                                                                                                                                                                                                                                                    |
| --- | -------- | ---------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Medium   | High       | `apps/server/src/services/sync.ts:47`, `:77`, `:105`, `:112`            | `fetchArr` returned the same `null` for the documented "the \*arr does not have this item" signal (a real 404 with `notFoundOk`, an empty \*arr DELETE) **and** for a 200 response whose JSON body is literally `null`. `expectObject` then read that parsed `null` as absence, so `syncOneItem` **deleted the tracked row and its verdicts** on a wrong-shaped 200 body (truncation, auth proxy, API-version change). This is the remaining gap in the round-2 fix that made empty 200 bodies errors: `null` is valid JSON, so it slipped through the empty-body guard. Reproduced: single-item GET answering `null` → `syncOneItem` returned `{found:false,changed:true}` and the row was gone; the series endpoint had the same hole for episode rows.                                                                   | The not-found signal is now `undefined` (`fetchArr` returns it only for a real 404 or an empty DELETE body); `expectObject` accepts only `undefined` as absence and throws on a parsed `null`, so wrong shapes fail the request and leave the row alone.                                                                | `apps/server/test/sync.test.ts:836` (200 `null` single movie rejects, row+path kept), `:853` (200 `null` series rejects, episode row kept); `apps/server/test/fetcharr.test.ts:67`, `:79` (not-found signal is `undefined`) and `:83` (JSON `null` stays data). Pre-fix: 4 tests failed (rows deleted / signal mismatch).                          |
| 2   | Medium   | High       | `apps/server/src/services/sync.ts:338`, `:404-421`, `:571-596`          | A `purged` row whose replacement download lands at the **same path** was never picked up. `syncSource`'s upsert keeps verdicts for an unchanged path and `syncOneItem`'s same-path branch only refreshed metadata, so the row stayed `purged` with the deleted file's stale `error_detail`/probe data and was skipped by every `unchecked` scan; only an `all`/`purged` scan or a re-check cleared it. Same-path replacements are realistic (a re-grab of the same release, and Sonarr's default episode naming omits the release group). Reproduced through the API: purge → replacement at the old path → sync reported `relinked: 0, updated: 1` and the row stayed `purged` with `error_detail: "old verdict"`.                                                                                                         | A purged row is special-cased in both sync paths: when the \*arr reports a file at the purged row's path, the old bytes are gone by definition, so the row is reset exactly like a relink (path/metadata refreshed from the \*arr, status `unchecked`, verdict/probe/checked fields cleared) and counted as `relinked`. | `apps/server/test/sync.test.ts:309` (full sync resets a same-path replacement, `relinked: 1`), `:625` (single-item sync reports `changed: true` and resets the row). Pre-fix: `relinked` was 0 / `changed` was false.                                                                                                                              |
| 3   | Low      | High       | `apps/server/src/routes.ts:690-691`                                     | `GET /api/files?sort=__proto__` (or `constructor`, `toString`, any other inherited name) returned **HTTP 500**. The sort whitelist was a plain object, so `sortMap[q.sort]` returned an inherited prototype value, which was concatenated into `ORDER BY [object Object] DESC` and hit SQLite as a syntax error. Malformed input surfaced as an unhandled 500 instead of the documented default listing — the same class of bug as the 2026-11-08 page/pageSize finding.                                                                                                                                                                                                                                                                                                                                                    | Own-property check (`Object.hasOwn`) before reading the whitelist; unknown values fall back to the `id` sort.                                                                                                                                                                                                           | `apps/server/test/routes.test.ts:346` — `__proto__`, `constructor`, `toString`, `hasOwnProperty` answer 200 with a normal item list. Pre-fix: 500.                                                                                                                                                                                                 |
| 4   | Low      | High       | `apps/server/src/routes.ts:486-489`                                     | `POST /api/purge` only validated the status **after** defaulting any non-string value to `"corrupt"`. A wrong-typed body (`{status: ["all"]}`, `{status: 123}`, `{status: null}`, `{status: ""}`) therefore silently ran the destructive default (`corrupt` purge, no `confirm` needed) instead of 400ing. A client bug could delete a different set of files than requested.                                                                                                                                                                                                                                                                                                                                                                                                                                               | Only a _missing_ status keeps the historical `"corrupt"` default; any value that is present must be one of `PURGE_STATUSES` (string) or the request is rejected with 400 before the batch gate or any \*arr call.                                                                                                       | `apps/server/test/routes.test.ts:357` — array/number/boolean/null/empty-string statuses answer 400, nothing is deleted. Pre-fix: 200 (corrupt purge).                                                                                                                                                                                              |
| 5   | Low      | High       | `apps/web/src/components/DetailModal.tsx:14-35`, `:102`, `:119`, `:140` | The detail modal rendered the `<video>` player for `purged`, `missing` and `unreachable` rows. Those files are known not to be playable: purged = deleted by Delete & re-search (the row may keep the old path until a later sync reports no file, which NULLs it while keeping `purged`), missing = the checker could not find the file on disk, unreachable = the file exists but cannot be read (the stream endpoint stats OK and fails only when the stream opens, after the 200 headers). The player therefore failed with "Browser playback failed. The codec may be unsupported…", a misleading user-visible state, and "Jump to middle" could never work. **Round-2 correction:** the original fix only special-cased `path` for the copy and still played `unreachable` rows; both are corrected in round 2 below. | The player is only rendered when the file is playable (`path !== null` and status not `purged`/`missing`/`unreachable`); those rows get status-first, accurate copy (deleted-awaiting-replacement / not-downloaded-yet / not-on-disk / permissions) and Jump-to-middle is disabled.                                     | `apps/web/test/DetailModal.test.tsx:64` (purged row: no `<video>`, waiting note), `:75` (missing-on-disk row), `:91` (fileless missing), `:100` (purged row whose path a later sync NULLed still says awaiting replacement - round 2), `:112` (unreachable row: no `<video>`, permissions note - round 2). Pre-fix: players rendered / wrong copy. |
| 6   | Low      | High       | `docs/agents/codebase-map.md:3`, `:130-143`                             | The agent routing map's File index was incomplete: `apps/web/src/index.css`, `ui/Button.tsx`, `ui/controls.tsx`, `ui/ErrorBanner.tsx` and `ui/Toggle.tsx` were missing, although the map's own maintenance rule requires the index after adding source files (all five predate the map). `Verified against` still named `d7c9acd` although the map ships at `ec361bd`. Agents using the map as a lookup table would not find the UI primitives.                                                                                                                                                                                                                                                                                                                                                                             | Added the five missing entries and bumped `Verified against` to the audited commit `ec361bd`.                                                                                                                                                                                                                           | Docs-only; verified by diffing `git show HEAD:docs/agents/codebase-map.md` against `find apps/web/src -type f` (5 pre-fix omissions, 0 post-fix).                                                                                                                                                                                                  |

No new dependencies were added; no existing test was weakened or deleted (the two `fetchArr` assertions
were updated to the corrected not-found contract and are covered by new tests that fail pre-fix). The audit
changes do not modify version files.

## Verification results

All commands run from the repo root on the audit machine, after the fixes:

| Command             | Result                                                                               |
| ------------------- | ------------------------------------------------------------------------------------ |
| `pnpm lint`         | pass (`eslint .`, no output)                                                         |
| `pnpm format:check` | pass ("All matched files use Prettier code style!")                                  |
| `pnpm typecheck`    | pass (server `tsc` src + test config; web `tsc --noEmit`)                            |
| `pnpm test`         | **pass — 248 tests, 0 failed, 0 skipped**: scripts 50, server 159 (+7), web 39 (+4)  |
| `pnpm build`        | pass (`tsc` server + `vite build`, 94 modules; web dist JS 290.36 kB, gzip 88.60 kB) |

Baseline for comparison (`ec361bd`, before any change): all five gates green, **237 tests** (scripts 50,
server 152, web 35, 0 skipped), web dist JS 289.81 kB / 94 modules.

Additional verification:

- **Pre-fix failure evidence.** All regression tests were run against the unmodified source before the fix
  (`pnpm -F @checkarr/server exec vitest run test/sync.test.ts test/fetcharr.test.ts test/routes.test.ts` →
  **8 failed / 73 passed**; `pnpm -F @checkarr/web exec vitest run test/DetailModal.test.tsx` → the two new
  player tests failed). Concrete pre-fix results: a 200 `null` single-item body returned
  `{found:false,changed:true}` and the row was deleted; a same-path replacement sync reported `relinked: 0`;
  `sort=__proto__` answered 500; purge with `status: ["all"]`, `123`, `true`, `null`, `""` answered 200.
  The docs finding was verified against `git show HEAD:docs/agents/codebase-map.md` (5 missing files).
- **End-to-end HTTP probe** (temp in-memory DB, in-process stub Radarr with a real file on disk, `app.inject`):
  add source → `POST /api/sync` (1 row) → mark corrupt → `POST /api/purge {status:"corrupt"}` (200,
  `deleted: 1`, row `purged`, path kept) → replacement lands at the same path → `POST /api/sync`
  (200, `relinked: 1`, row `unchecked`, stale `error_detail` cleared) → single-item GET answering `null` →
  `POST /api/files/1/recheck` (502 "returned an unexpected response", row intact/healthy) →
  `GET /api/files?sort=__proto__` (200, 1 item) → `POST /api/purge {status:["all"]}` (400) →
  `GET /api/stats` (`healthy: 1`, `purged: 0`). No server was left running.
- **Other code paths re-checked while hunting but not changed:** scan lifecycle/cancel and batch gate,
  host + cross-site guards, migrations on legacy schemas, real ffmpeg classification
  (`checker.integration.test.ts` 8 real-media tests), launcher/desktop/tray scripts, Docker/CI. No new
  defect found there; the prior deferred items below still stand.

## Verification follow-up (round 2)

An independent verifier re-reviewed this audit against the local fix commits. Findings 1-4 and 6 were
verified (the 10 pre-fix failures reproduced independently in a temporary worktree at `ec361bd`; all gates
independently green at 248 tests, baseline 237 re-confirmed); finding 5's core defect was verified but its
"accurate copy" claim was overstated. Every verifier item below was reproduced against the round-1 code
before the change. No High/Medium new defect was found and no verifier item was rejected.

| #   | Verifier item                                                                                                                                                                                                                                                                                                                                                                           | Verdict                        | Fix and evidence                                                                                                                                                                                                                                                                                                    | Regression tests                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | LOW: `goneFileMessage` checked `path === null` before the status, so a `purged` row whose path was NULLed by a later sync (sync keeps `purged` and sets `path` NULL, `apps/server/src/services/sync.ts:366-371`) said "has not been downloaded yet" instead of "deleted, awaiting replacement". The report's finding-5 claim that the path stays until the replacement lands was false. | Accepted                       | Message precedence is now status-first (`purged` before `path === null`), so both purged shapes (old path or NULL path) say awaiting replacement; the DetailModal comments and the finding-5 row/report claim are corrected. Reproduced before: purged + NULL path rendered the "has not been downloaded yet" copy. | `apps/web/test/DetailModal.test.tsx:100` (purged + NULL path: waiting-for-replacement note, not downloaded-yet; no `<video>`). Pre-fix: wrong copy.                                                                                                                                |
| N2  | LOW (borderline): `unreachable` rows still got a `<video>`. `/api/files/:id/stream` (`apps/server/src/routes.ts:815-854`) only stats the file (EACCES does not fail `stat`) and `createReadStream` errors only after the 200 headers, so the browser's error event produced the misleading "codec may be unsupported" copy.                                                             | Accepted (fixed, not deferred) | The player is not rendered for `unreachable` rows either; the modal explains the permission problem and points at Re-check, and Jump to middle is disabled. Reproduced before: player rendered, no permissions message.                                                                                             | `apps/web/test/DetailModal.test.tsx:112` (unreachable row: no `<video>`, permissions note). Pre-fix: player rendered.                                                                                                                                                              |
| N3  | LOW: `docs/agents/codebase-map.md` still said `Verified against ec361bd` while HEAD moved; 3 of 34 file:line refs were stale (`sync.ts:67`→`77` fetchArr, `sync.ts:308`→`318` syncSource, `routes.ts:531`→`535` SCAN_SCOPES); `apps/server/scripts/debug-check.ts` was absent from the File index (pre-existing).                                                                       | Accepted                       | All 34 `path:line` refs were re-resolved programmatically against the final source tree (each names the expected declaration/comment), the three stale ones corrected, `debug-check.ts` added to the File index, and `Verified against` now names the final source commit `7824385`.                                | Docs-only; verified by a script that resolves every ref in the map (0 empty/wrong) and by diffing the File index against `find apps/server/src apps/server/scripts apps/web/src scripts -type f` (only `scripts/test/*.test.mjs` remain unlisted, matching the source-only index). |

Round-2 gate (all green): `pnpm lint` pass; `pnpm format:check` pass; `pnpm typecheck` pass;
`pnpm test` **250 passed / 0 failed / 0 skipped** (scripts 50, server 159, web 41 — 2 net new web tests);
`pnpm build` pass (94 modules, web dist JS 290.36 kB). No new dependencies; version files untouched.

Rejected / not changed: nothing from the verifier list was rejected.

## Deferred items (with rationale)

1. **Multi-episode files collapse to one row.** Identity is `UNIQUE (source_id, path)` (`apps/server/src/db.ts:48`,
   upsert at `apps/server/src/services/sync.ts:330`), so two Sonarr episodes sharing one file become one row;
   the second entry overwrites `external_id`/`subtitle`. Reproduced in the 2026-11-08 audit; fixing needs a
   schema identity change plus scanner/purge assumptions. Unchanged, still too risky for this pass.
2. **Explicitly scoped disabled source: purge/re-search sync it but then silently act on nothing.**
   `syncSourcesForBatch` syncs an explicitly selected source even when disabled (matching `/api/sync` and
   scan semantics), but `purgeFiles`/`researchMissing` filter `WHERE s.enabled = 1` (`apps/server/src/services/purge.ts:228`,
   `apps/server/src/services/research.ts:71`). A dashboard user who selects a disabled source and clicks
   Delete & re-search / Re-search missing gets `total: 0` with no explanation. Product decision needed.
3. **Docker image carries both ffmpeg builds.** The resolver prefers the bundled static binaries on
   linux/x64, so the system ffmpeg installed by the image is only a fallback (documented). Stripping the
   bundled binaries would change the Docker build with no functional gain; left as-is.
4. **`CHECKARR_PORT`/`PORT` is not validated.** A non-numeric value produces `PORT = NaN` and a cryptic
   `listen` failure at startup (`apps/server/src/config.ts:10`, and the start/stop/launch scripts parse the same
   env); a clean fix needs module-load-time validation shared by the server and the launchers. Low impact,
   unchanged from the 2026-11-08 deferral.
5. **Per-file re-check can overlap a scan that starts while it is decoding.** The route checks
   `scans.isActive()` before and after its item sync but does not hold the batch gate across the
   multi-second decode; the path/purged write guard makes the residual race benign (last verdict wins, no
   deletion). Deliberately not widened to gating whole decodes.
6. **`pnpm start`/`stop`/`launch`/tray keep pid/log/state in `data/` even when `CHECKARR_DATA_DIR` is set.**
   The README only promises that the SQLite directory is overridable; changing every script's state dir is a
   broader behavioural change than this audit should make.
7. **The dev \*arr stub used by the README "Try it in 30 seconds" flow lacks the per-file endpoints the UI
   calls.** `scripts/dev/stub-arr.mjs` implements only list-level routes, so in the demo "Re-check now" /
   per-file "Delete & re-search" answer 404, which makes `syncOneItem` delete that demo row and the toast
   report the item as gone; bulk Delete & re-search reports every file as failed. This is a dev fixture, not
   shipped behaviour, and fixing it properly needs a testable handler refactor plus a spawn-based test; the
   README's documented 30-second steps (add source, sync, scan) work. Deferred rather than expanded in scope.
8. **A Cancel click in the few-ms window before the scan request reaches the server can be missed.** The UI
   allows Cancel while the optimistic start mutation is in flight; if the cancel request arrives before the
   scan route sets its `pendingScan` flag, the scan starts. The server-side flag closes the much larger
   pre-sync window; this residual client/server ordering race is not worth additional protocol state.

## Notes

- No push, tag, release or version bump was made; no `.git` state outside a local commit was touched. The
  audit did not edit version files. Working tree contains only the fixes, the new regression tests, the docs
  map update and this report.
- Files changed:
  `apps/server/src/routes.ts`, `apps/server/src/services/sync.ts`,
  `apps/server/test/{fetcharr,routes,sync}.test.ts`,
  `apps/web/src/components/DetailModal.tsx`, `apps/web/test/DetailModal.test.tsx` (new),
  `docs/agents/codebase-map.md`, `docs/audits/2026-11-12-code-quality-audit.md` (this file).
- Gate counts were measured from the exact commands in the Verification results table on the audit machine;
  the 250 total is scripts 50 + server 159 + web 41.
- Local commits: `90ef861` (audit fixes), `37d7a49` (audit report), `7824385` (verification follow-up
  fixes), plus the round-2 docs commit. Nothing was pushed, tagged or released.
