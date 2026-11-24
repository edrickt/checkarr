# checkarr — code-quality and security audit (2026-11-24)

> **Status: report only.** No file in this repository was modified. Every finding carries a
> proposed fix for review; no regression test was added and no version file was touched.
> Gates at audit: 281 tests pass, `lint`, `format:check`, `typecheck`, `build` all pass.

## Baseline

- Repository: `/Users/etm1air/Files/Github/checkarr`, branch `main`, HEAD `cac4be4` ("docs: refresh demo GIF for the new UI"), working tree clean at audit start. No file inside the repo was modified.
- Environment: macOS (arm64), Node v24.21.0, pnpm 11.7.0.
- Gates, all five run from the repo root on the untouched baseline — **all pass**:

| Gate | Result |
| --- | --- |
| `pnpm lint` | **pass** — `eslint .`, no findings |
| `pnpm format:check` | **pass** — "All matched files use Prettier code style!" |
| `pnpm typecheck` | **pass** — server `tsc` + test config + web `tsc --noEmit` |
| `pnpm test` | **pass — 281 tests, 0 failed**: `apps/server` 168 (11 files, 2.80 s), `apps/web` 63 (10 files, 4.51 s), root script suites 50 (50 + 168 + 63 = 281) |
| `pnpm build` | **pass** — server `tsc`, web `vite build` 603 ms; `dist/assets/index-B8k6iaym.js` 305.93 kB (gzip 92.15 kB), CSS 29.25 kB (gzip 6.38 kB) |

No gate was skipped or assumed. Nothing in this audit changes a file, so the final state is identical to the baseline.
- LOC in scope: ≈10.4k lines (`wc -l` over `apps/server/src`, `apps/server/scripts`, `apps/web/src`, `scripts`, `docker`, `.github`); the server/web test suites add ≈4.3k more.
- UI note: the 2026-11-24 rebuild (`ea06d12`, `0fbf2de`, `b5287a4`) is what was audited — every UI finding below was re-derived from the current source, none from the 2026-11-12 report.

## Scope and method

Read in full: `AGENTS.md`, `docs/agents/codebase-map.md` (its "Don't read" set was honoured), `README.md` (including "How it works", "Verdicts", "Security", "Configuration", the endpoint list), `DESIGN.md` (skimmed for the status/colour vocabulary), and `docs/audits/2026-11-12-code-quality-audit.md` (used only as the list of findings to re-check).

Read source: all of `apps/server/src/**` (`routes.ts`, `app.ts`, `db.ts`, `settings.ts`, `config.ts`, `index.ts`, `lib/*`, `services/*`), `apps/server/scripts/debug-check.ts`, all of `apps/web/src/**` (shell, router, hooks, API client, `useScan`, all components, all UI primitives), `scripts/**` (`start`, `stop`, `launch`, `desktop`, `tray`, `lib/{launcher,desktop,tray,icon}`, `dev/{stub-arr,gen-sample-media}`), `docker/Dockerfile`, `docker/docker-compose.yml`, `.github/workflows/ci.yml`, `Checkarr.command`, both vitest configs, root/app `package.json`s, and the test titles of every existing suite.

Probes (all under `/tmp/code-audit/probes/`, throwaway, in-memory SQLite, temporary stub servers, no real `data/`, no real *arr, nothing left listening):

- `probe1.mjs` — `buildApp` over `:memory:` + `app.inject`: pagination/sort/filter validation, the full `Range` matrix on `/stream` (including 0-byte files), host-guard variants, and the mutating-request guards.
- `probe2.mjs` — a stub Sonarr with a per-request delay: measured the library-sync request pattern; exercised `persistCheckOutcome` on a purged row; attempted to model a shared-path (multi-episode) purge.
- `probe3.mjs` — a stub "Radarr" that answers every path with a cross-origin `302` to a second stub: proved redirect following and `X-Api-Key` forwarding.

Deliberately skipped: `node_modules/`, `dist/`, `data/`, `pnpm-lock.yaml`, `docs/assets`, coverage output (per the codebase map). No browser/macOS/Windows runtime was available, so the platform-specific tray and desktop bundles are audited by inspection only. No style, naming or formatting findings are reported.

## Findings

### CA-01 — *arr requests follow cross-origin redirects and forward the API key

- **Severity:** Medium
- **Confidence:** High
- **Class:** security
- **Location:** `apps/server/src/services/sync.ts:88`, `apps/server/src/services/sync.ts:91`, `apps/server/src/routes.ts:394`
- **Code:**
```ts
    res = await fetch(root + apiPath, {
      method,
      headers: {
        "X-Api-Key": apiKey,
        Accept: "application/json",
```
- **Defect:** `fetchArr` calls `fetch` with no `redirect` option, so `redirect: "follow"` applies. Node's undici strips `Authorization` on a cross-origin redirect but **not** custom headers, so `X-Api-Key` is replayed to whatever host the *arr points at. The base URL is only checked for an `http(s)` prefix (`routes.ts:394`), never for redirect behaviour, and every *arr call in the app (sync, purge, research, per-item sync, connection test) goes through this one function.
- **Impact:** Two concrete consequences. (1) **Secret exfiltration:** a *arr behind an SSO/reverse proxy that answers an expired session with a `302` to the identity provider hands the real API key to that third-party origin. (2) **SSRF with a response oracle:** on a broadcast/LAN deployment (the documented Docker setup) any host on the network can `POST /api/sources {baseUrl:"http://attacker/redir"}` where `redir` 302s to `http://169.254.169.254/…` or any internal service; `POST /api/sources/:id/test` returns the target's `appName`/`version` and `/api/sync` returns row counts derived from the target's JSON, so the blind fetch becomes a readable probe.
- **Proposed fix:** pass `redirect: "manual"` in `fetchArr` and treat a 3xx as a hard error naming the `location` (an *arr should never redirect an API path), or at minimum re-send the key only when `new URL(res.url).origin === new URL(root).origin`. Add a test in `fetcharr.test.ts` with a 302 to a second local server asserting the key is not replayed.
- **Evidence:** probe at `/tmp/code-audit/probes/probe3.mjs` (stub Radarr on port A answering every path with `302 → http://127.0.0.1:<B>/latest/meta-data/`). Observed:
  `testSource through a cross-origin 302 -> {"ok":true,"appName":"Radarr","version":"5.14.0-internal","mismatch":false}`
  `internal service received -> [{"url":"/latest/meta-data/","key":"REAL-SECRET-KEY"}]`
  `fetchArr returned the redirect target's JSON -> {"appName":"Radarr","version":"5.14.0-internal","secret":"internal-data"}`

### CA-02 — Sonarr sync is one serial *arr request per series (N+1) while holding the global batch gate

- **Severity:** Medium
- **Confidence:** High
- **Class:** performance
- **Location:** `apps/server/src/services/sync.ts:239`, `apps/server/src/services/sync.ts:246`, `apps/server/src/routes.ts:579`
- **Code:**
```ts
  for (const rawSeries of series) {
    const s = expectEntry<SonarrSeries>(rawSeries, "GET /api/v3/series");
    requireNumericId(s, "GET /api/v3/series");
    const episodesUrl = "/api/v3/episode?seriesId=" + s.id + "&includeEpisodeFile=true";
    let episodes: SonarrEpisode[];
    try {
      episodes = expectList<SonarrEpisode>(
        await fetchArr(baseUrl, apiKey, episodesUrl),
```
- **Defect:** `/api/v3/series` is fetched once, then the episode list is fetched **sequentially, one `await` per series**, with no concurrency and no overall deadline (each request only has the 20 s `AbortSignal.timeout` from `fetchArr`). That whole loop runs inside `syncSourcesForBatch` → `runBatch("scan"|"delete"|"re-search")`, so the single batch slot is held for the entire duration and no scan, purge or re-search can start (they answer 409). A slow or hanging *arr multiplies the worst case by the series count, and `/api/scan/cancel` cannot shorten it.
- **Impact:** library sync time scales linearly with series count on top of per-request latency. Measured: 12 series × 100 ms = 1.375 s with **zero** overlapping requests; 200 series ≈ 20 s at an optimistic 100 ms/request, and 40–100 s at a realistic 200–500 ms. For every second of that the dashboard's Scan / Delete / Re-search buttons are dead and `POST /api/scan` is pinned open. This is the single largest practical latency source in the app and it is amplified by the 100–700 series libraries Sonarr users typically have.
- **Proposed fix:** bound the fan-out with a small worker pool (the codebase already has `mapLimit` in `purge.ts:29` — reuse it with a limit of 4–6) and add a per-sync deadline that aborts remaining requests. Keep the ordering of the output array deterministic so `syncSource`'s upsert order stays stable.
- **Evidence:** probe at `/tmp/code-audit/probes/probe2.mjs` (part a), stub Sonarr with a 100 ms delay per response:
  `(a) sonarr sync: entries=12 requests=13 elapsedMs=1375 overlappingRequests=0 (delay 100ms each, 12 series)`
  `(a) extrapolated 200 series: 20s wall time`

### CA-03 — Per-file re-check is outside the batch gate, and the purged-row write guard only covers `missing`

- **Severity:** Low
- **Confidence:** High
- **Class:** concurrency
- **Location:** `apps/server/src/routes.ts:809`, `apps/server/src/services/scanner.ts:62`, `apps/server/src/services/scanner.ts:63`
- **Code:**
```ts
  app.post("/api/files/:id/recheck", async (req) => {
    if (scans.isActive()) throw new ApiError(409, "A scan is running - wait for it to finish or cancel it");
    const id = Number((req.params as { id: string }).id);
    ...
  if (!cur || cur.path !== file.path) return { wrote: false, reason: "row-changed" };
  if ((file.status === "purged" || cur.status === "purged") && outcome.status === "missing") {
    return { wrote: false, reason: "purged-awaiting-replacement" };
  }
  persistOutcome(db, file.id, outcome);
```
- **Defect:** `/api/files/:id/recheck` is the only media-mutating route that is **not** wrapped in `runBatch` (compare `:754` purge, `:774` research, `:575` scan, `:450` sync); it checks `scans.isActive()` before and after the item sync, then decodes for up to ~4 minutes with nothing holding the gate. A concurrent `POST /api/files/:id/purge` (which *does* take the gate) can therefore unlink the file while the re-check's ffmpeg still has it open — POSIX keeps the inode readable after `unlink`. `persistCheckOutcome` only refuses a stale verdict when the outcome is `missing`; when the last decode step had already opened the file the outcome is `healthy` (or `corrupt` for a partial read) and the write **lands**, replacing `purged` with a verdict about bytes that no longer exist. This is the residual race the 2026-11-12 audit deferred as "benign" (deferred item 5, `scanner.test.ts:311` covers only the `missing` outcome).
- **Impact:** a user's Delete & re-search is silently undone: the row shows `healthy`/`corrupt` with the deleted file's path, so it disappears from the "purged / waiting" views and is never offered a replacement search, until the next sync notices the file is gone (it parks the row `missing`) or drops it. The user sees a file they just deleted come back as healthy.
- **Proposed fix:** (a) make the guard status-first rather than outcome-first — `if ((file.status === "purged" || cur.status === "purged") && !outcomeWroteTheRowAfterPurge) return {wrote:false,…}` i.e. refuse *every* outcome when the row became `purged` after the check started; and (b) wrap the re-check body in `runBatch("re-check", …)` so a purge cannot interleave at all. The cheapest correct version is (a) plus a `cur.status === "purged"` re-read immediately before `persistOutcome`.
- **Evidence:** probe at `/tmp/code-audit/probes/probe2.mjs` (part b), a purged row with an in-flight outcome:
  `(b) purged row + in-flight recheck returns healthy -> wrote={"wrote":true,"status":"healthy"} status now=healthy`
  `(b) same, outcome missing -> wrote={"wrote":true,"status":"missing"} status now=missing`
  (the second line is the pre-existing guard firing for a *non*-purged row, confirming the guard is outcome-scoped). The interleaving itself needs real ffmpeg + a real delete — see "Needs runtime verification".

### CA-04 — The dev *arr stub has no per-item endpoints, so the documented walkthrough's Re-check / Delete deletes the row

- **Severity:** Low
- **Confidence:** High
- **Class:** correctness
- **Location:** `scripts/dev/stub-arr.mjs:108`, `scripts/dev/stub-arr.mjs:117`, `README.md:53`
- **Code:**
```js
createServer(
  handler("Radarr", {
    "/api/v3/system/status": { appName: "Radarr", version: "5.14.0.9603" },
    "/api/v3/movie": movies
  })
).listen(8699, "127.0.0.1");
```
- **Defect:** the stub's route table contains only `system/status`, `movie`, `series`, `episode` (plus the seriesId validation). It has no `GET /api/v3/movie/:id`, no `GET /api/v3/episode/:id`, and no `DELETE /api/v3/moviefile/:id` / `episodefile/:id` / `POST /api/v3/command`. The stub answers unknown paths `404 "{}"`. `syncOneItem` uses `fetchArr(..., { notFoundOk: true })`, so that 404 is taken as "the *arr no longer has this item" and the route's **`DELETE FROM media_files`** branch runs. The README's "Try it in 30 seconds" flow ends with a table of files and a "Fix it in one click" promise, and the row menu's first per-file action is "Re-check now", so the first thing a new user tries after sync deletes their demo row and toasts `the *arr no longer has this item - it was removed during sync`.
- **Impact:** the advertised zero-config evaluation flow reports that the sample library vanished, and per-file Delete & re-search answers 404 / reports every file failed — a new user's first interaction with the app's headline feature. Not shipped behaviour (dev fixture only), but it is the documented onboarding path.
- **Proposed fix:** add the missing handlers to `stub-arr.mjs`: `/api/v3/movie/:id`, `/api/v3/episode/:id?includeEpisodeFile=true` (the real Sonarr contract), `DELETE /api/v3/moviefile/:id` + `DELETE /api/v3/episodefile/:id` returning an empty 200, and `POST /api/v3/command` echoing `{id:1}`; mutate the in-memory `movies`/`episodes` arrays on delete so a re-sync shows the gap. Add a spawn-based test under `scripts/test/` that asserts those routes exist, which is what keeps the README honest.
- **Evidence:** read-only trace of the route table above (Radarr: two paths; Sonarr: `system/status`, `series`, `episode` at `:117-119`, nothing else) plus `sync.ts:544-552` (`entry === null` → `DELETE FROM media_files`). A runtime probe was not possible inside the rules: the stub exits unless the gitignored `data/sample-media` fixtures exist, and this audit must not create files in the repo.

### CA-05 — Media paths are used verbatim, so the stream and checker endpoints read any path the *arr reports

- **Severity:** Low
- **Confidence:** High
- **Class:** security
- **Location:** `apps/server/src/routes.ts:873`, `apps/server/src/routes.ts:897`, `apps/server/src/services/checker.ts:132`
- **Code:**
```ts
    if (row.path === null) throw new ApiError(404, "no file at the *arr for this item");
    const localPath = resolveLocalPath(row.path, getSettings(db).pathMappings);
    let size: number;
    try {
      const st = await fs.promises.stat(localPath);
      if (!st.isFile()) throw new ApiError(404, "not a regular file");
```
- **Defect:** `resolveLocalPath` is a pure prefix rewrite with no confinement: there is no check that the resolved path is inside any mapped media root, no rejection of `..` segments, and no allowlist of extensions before `fs.createReadStream`. The path is whatever the *arr reported (or a path mapping rewrote), and the stream endpoint serves it to any caller the host guard admits. `checkMediaFile` does the same for the checker's stat/ffprobe/ffmpeg.
- **Impact:** defence in depth: a compromised or impersonated *arr (`GET /api/v3/movie` is trusted blindly once the key matches, and CA-01 lets any LAN client create a source), a hostile reverse proxy, or a wrong path mapping (`match: "/movies"`, `replace: "/"`) turns Checkarr into an unauthenticated arbitrary-file reader for anything the server user can read — `/etc/passwd`, SSH keys, the SQLite DB itself, `data/server.log`. The README documents path mappings as the mechanism that must be configured correctly, but nothing enforces it.
- **Proposed fix:** after resolving, reject paths that are not absolute, contain `..` after normalisation, or whose `realpath` does not start with one of the configured `replace` roots (when at least one mapping exists); apply it in one helper used by both the stream route and `checkMediaFile`. Cheap and testable without touching the happy path.
- **Evidence:** probe at `/tmp/code-audit/probes/probe1.mjs` streamed a file outside any media root: a DB row was given `path = /var/folders/…/checkarr-probe1-XXXX/media.bin` (a temp dir) and `GET /api/files/<id>/stream` answered `200 len=10`, `206 bytes 0-9/10` for `Range: bytes=0-`; the code excerpt shows no root check on the way in.

### CA-06 — Settings keeps a stale "Test connection OK" after the source's URL or key is edited

- **Severity:** Low
- **Confidence:** High
- **Class:** correctness
- **Location:** `apps/web/src/components/SettingsPage.tsx:246`, `apps/web/src/components/SettingsPage.tsx:358`, `apps/web/src/components/SettingsPage.tsx:379`
- **Code:**
```tsx
    mutationFn: (id: number) => api.testSource(id),
    onSuccess: (r, id) => {
      setTestResults((prev) => ({
        ...prev,
        [id]: r.ok
```
```tsx
                    <Button onClick={() => updateSource.mutate(editing)} disabled={updateSource.isPending}>
                      {updateSource.isPending ? "Saving..." : "Save"}
```
- **Defect:** `testResults` is only ever added to (`setTestResults(prev => ({...prev, [id]: …}))`). Neither the `updateSource` success handler nor the add/delete handlers clear or overwrite the entry for that id, so the green `OK: Radarr 5.14.0` line rendered at `:379` survives an edit that changed `baseUrl` and/or `apiKey`. It is also kept when the source is toggled or renamed.
- **Impact:** the settings page tells the operator a connection works when the URL/key currently saved was never tested — exactly the field pair that decides whether every sync, purge and re-search will fail. The `last_sync_error` line right above it is refreshed by the server, so the two lines can contradict each other. Small, but it is a trust signal on the one screen where configuration mistakes are made.
- **Proposed fix:** clear the entry where the config changes — `updateSource.onSuccess: (_data, s) => { setTestResults((prev) => { const next = { ...prev }; delete next[s.id]; return next; }); … }` — and do the same for `toggleEnabled`/`deleteSource`; or key the map by `id + baseUrl + apiKey` so a changed config can never show a stale verdict.
- **Evidence:** read-only trace: `testResults` is referenced at `:95` (init), `:246` (write), `:379`/`:383`/`:386` (read) and nowhere else; `rg "setTestResults"` returns exactly those two sites, so no invalidation path exists. `SettingsPage.test.tsx` has 15 tests, none of which exercises test-then-edit.

## Checked and clean

- **HTTP guards (`app.ts:90-141`)** — probed: `Host: 127.0.0.1:5656`, `localhost`, `[::1]:5656`, `LOCALHOST` → 200; `127.0.0.1.evil.com`, `evil.com` → 403. `text/plain` write body → 415; `sec-fetch-site: cross-site` → 403; `Origin: http://evil.example` → 403. `stripPort` handles bracketed IPv6 and a single colon without mistaking a hostname suffix for a port. No `Access-Control-*` header is ever emitted, so there is no CORS read path.
- **Route input validation (`routes.ts`)** — probed: `sort=__proto__`/`constructor` fall back to the `id` sort (200, prior-audit fix intact); `status=nope` → 400 with the allowed list; `pageSize=100000` clamps to 200; `page=2^54` falls back to 1; `q=%` is escaped through `escapeLike` + `ESCAPE '!'` and matches nothing rather than everything. `purge`/`research`/`scan` reject wrong-typed `status`/`scope`/`sourceId` before any *arr call.
- **Range/stream (`routes.ts:71-110`, `:866-905`)** — probed the full matrix: `bytes=0-` → 206 with the right `content-range`, `0-0` → 206/1, `-5` → 206/5, `-0`/`5-2`/`99-`/`0-1,4-5` → 416 with `content-range: bytes */size`, and 0-byte files → 416 for any range, 200/len=0 for no range. The `end === -1` crash class called out in the prior audit is gone.
- **Scan lifecycle (`scanner.ts`)** — the run slot is claimed synchronously before any `await` (`start` sets `running` ahead of `binariesUsable`), so two concurrent scan requests cannot both start; `cancel()` is a no-op when idle so it cannot rewrite a settled run; cancelled workers return items to `pending` instead of persisting a killed-process verdict; `done` is only incremented when the `scan_items` UPDATE actually changed a row, so a cascade-deleted row cannot push `done` past `total`; a worker DB failure sets `failed`, aborts the sibling workers' signal and finalises the run; `resumeInterruptedScans` resets `running` items and marks orphaned runs cancelled.
- **Child-process handling (`ffmpeg.ts:148-215`)** — `runBin` resolves exactly once (`settled` latch), clears the timeout and the 2 s SIGKILL escalation timer on exit, removes the abort listener, disables the window on Windows, caps captured output, and reports `signaled` separately so a SIGKILL is never classified as a corrupt file. No `shell: true` anywhere in the server.
- **Checker (`checker.ts`, `classify.ts`)** — ENOENT at stat, at probe and mid-decode all map to `missing`, never `corrupt`; only ffprobe's `invalid data found when processing input` is `corrupt`, timeouts/other stderr are `suspect`; unknown duration skips middle/end and cannot be `healthy`; a clean exit-0 step without `-progress` evidence is rejected as inconclusive; argv is an array (no media path reaches a shell); `-max_pixels`/`-max_alloc` bound a hostile container.
- **Sync correctness (`sync.ts`)** — wrong-shaped 200s are hard errors, not empty libraries: non-array at the list level, non-object entries, a missing/non-integer `id`, an empty body on any non-DELETE, a parsed JSON `null` for a single item, and a series body without `seriesId`. `undefined` is the only "not found" signal. Cleanup runs from two temp tables in one transaction; purged rows get the same-path replacement reset and the relink reset; the relink target is guarded against an occupant of the same path; `syncOneItem` refuses to reuse a path another row owns.
- **Schema/migrations (`db.ts`)** — WAL, `foreign_keys = ON`, `busy_timeout = 5000`; both rebuilds run with FKs off inside an explicit transaction, restore `idx_media_files_status`/`idx_media_files_source` after dropping `media_files`, rename the legacy `re-searched` status, and are idempotent (`PRAGMA table_info` + `sqlite_master` checks).
- **Purge / re-search (`purge.ts`, `research.ts`)** — the path is re-verified against the *arr (`sameArrPath`) before any `DELETE`, so a stale row cannot cost a good file; a failing source is reported and the loop continues; searches are chunked at 200 ids; `markPurged` only runs after the *arr delete succeeded; the bulk routes hold the batch gate across sync+act.
- **Web UI** — no double-submit window I could find that reaches the server twice: every destructive mutation is behind `useConfirm`, the triggering buttons are `disabled` on `isPending`, and the scan start/cancel pair pauses the `["scan"]` poll through `useScanPollingGate` so the optimistic state is not clobbered. `ConfirmProvider` defaults focus to Cancel. `Modal` keeps a stack so Escape only closes the top layer. `DropdownButton`'s portal re-positions on capture-phase scroll and restores focus. `router.ts` validates every hash param against a whitelist and keeps `pageSize` in `[25,50,100,200]`. `LibraryTable` clamps an over-range page only after the listing for that query has loaded, so a deep link is not bounced to page 1.
- **Scripts** — no shell injection: ports and pids are `Number()`-coerced before interpolation; the only `shell: true` spawn is the constant `"pnpm build"`; `shQuote`/`psQuote`/`cQuote`/VBS quoting helpers are used for every embedded path; `start`/`stop` verify a pid's command line (`ps`/CIM) before killing and leave a foreign port holder alone; `launch.mjs` serialises concurrent double-clicks with an `wx`-created lock + stale-lock takeover; `needsBuild` compares real file mtimes (directories excluded).
- **Packaging** — the Docker image runs as `USER node`, publishes `127.0.0.1:5656:5656` only, bakes no secrets, and documents the HOST override. CI runs all five gates plus the Linux desktop-entry install and a macOS `.app`/`.icns` check.
- **Not applicable** — there is no SSE endpoint and no websocket anywhere in the server; the dashboard polls `/api/scan/current` (1.5 s while active, 30 s idle), `/api/stats` (1.5 s/10 s) and the table (5 s only while a scan runs), all of which react-query pauses in a hidden tab, so there is no fan-out or background re-render storm to report.

## Prior-audit disposition

- #1 `fetchArr` returning `null` as "not found" — **FIXED**. `expectObject` (`sync.ts:39-47`) accepts only `undefined`; `fetchArr` returns it solely for a 404 with `notFoundOk` (`sync.ts:105`) or an empty DELETE body (`sync.ts:112`).
- #2 Same-path replacement stuck `purged` — **FIXED**. `resetPurgedStmt` (`sync.ts:338`) in the full sync and the same-path branch in `syncOneItem` (`sync.ts:571-600`) reset status/verdict fields and count the row as relinked.
- #3 `sort=__proto__` → 500 — **FIXED**. `Object.hasOwn` guard (`routes.ts:703`); probe1 answers 200.
- #4 `POST /api/purge` wrong-typed status silently defaulting to `corrupt` — **FIXED**. `routes.ts:488-495` rejects any present non-`PURGE_STATUSES` value with 400 before the gate; `confirm: true` is still required for `all`/`healthy`.
- #5 Detail modal playing purged/missing/unreachable rows — **FIXED**. `playable` gate (`DetailModal.tsx:124-125`) excludes all three, and `goneFileMessage` is status-first so a purged row with a NULL path reads "awaiting replacement".
- #6 Codebase-map file index — **FIXED** (all five UI primitives are listed). One residual drift: the map still says `Verified against … last commit de2615f` while HEAD is `cac4be4`, so its `file:line` anchors predate the 2026-11-24 UI rebuild. Documentation only, no behavioural contradiction, so not raised as a finding.
- Deferred #2 (explicitly scoped disabled source: purge/re-search sync it then act on nothing) — **STILL PRESENT**. `purge.ts:228` / `research.ts:83` filter `s.enabled = 1` while `syncSourcesForBatch` syncs the explicit source anyway; the dashboard still offers the buttons for a disabled library.
- Deferred #4 (`CHECKARR_PORT` unvalidated) — **STILL PRESENT**. `config.ts:10` is a bare `Number(...)`; a non-numeric value yields `NaN` and a cryptic `listen` failure. Scripts coerce the same env var identically.
- Deferred #5 (per-file re-check can overlap a scan/purge) — **STILL PRESENT**, and no longer clearly benign: see CA-03.
- Deferred #7 (dev *arr stub lacks per-file endpoints) — **STILL PRESENT**; raised as CA-04 with the exact missing routes.
- Deferred #8 (Cancel clicked before the scan request lands can be missed) — **STILL PRESENT**. `pendingScan` (`routes.ts:165`) is set only once the route runs, so a cancel that arrives inside that few-ms window is dropped.

## Test-coverage gaps

- **Purged-row write guard, non-`missing` outcomes** (`scanner.test.ts:311` only asserts the `missing` case). Add: a purged row + `{status:"healthy"}` outcome must not write (this is CA-03); a purged row + `{status:"corrupt"}` likewise. Both fail on today's code.
- **Re-check route has no batch-gate test.** Add: hold `purge`/`scan` in flight (a stub *arr with a delayed response, the pattern already used for the scan-cancel test) and assert `/api/files/:id/recheck` answers 409 rather than decoding concurrently.
- **Redirect handling in `fetchArr`** (`fetcharr.test.ts`). Add: a stub that 302s to a second port must (a) not forward `X-Api-Key` and (b) not be accepted as a connection test.
- **Audit hooks on `scans` table / unbounded pages** (`routes.test.ts` already covers `__proto__` and non-integer pages). Add: `page` at `Number.MAX_SAFE_INTEGER` with `pageSize=200` returns an empty page rather than an error, pinning today's accidental-but-correct OFFSET behaviour.
- **Stream confinement.** `routes.test.ts` covers ranges but no path outside a mapping root. Add: a row whose path is outside every configured `replace` root must 403/404 once CA-05 is fixed.
- **Dev fixture contract** (`scripts/test/`). Add a spawn-based test that `stub-arr.mjs` answers `/api/v3/movie/:id`, `/api/v3/episode/:id`, `DELETE /api/v3/moviefile/:id` and `POST /api/v3/command` — the only thing that keeps the README walkthrough from rotting again.
- **SettingsPage stale test result.** Add: Test connection → edit the URL → save → the OK line is gone (CA-06).
- **`DELETE /api/sources/:id` during a scan** is untested; add a case asserting the run settles (state `done`, `done ≤ total`) and no worker throws after the cascade.
- **`purgeFiles` search-command failure** is covered (`purge.test.ts` "keeps deleted counts and reports the failure") — no gap there.

## Needs runtime verification

- **CA-03 end-to-end:** needs real media + a real (or slow-stub) Radarr delete. Steps: `pnpm gen:samples`, `pnpm stub:arr` extended with a 3 s delay on `DELETE /api/v3/moviefile/1`, `pnpm dev:server`, open the detail modal for a healthy sample, click Re-check and immediately Delete & re-search in a second tab, then read `GET /api/files/:id` — expect `status: "healthy"` with the deleted path (today) vs `purged` (after the fix). The last-decode-step window is sub-second, so repeat until the interleaving hits.
- **CA-01 in the field:** needs a *arr behind an SSO proxy (Authelia/oauth2-proxy) or a hostile proxy, plus a capture on the redirect target, to confirm the practical key-leak path. Steps: put `oauth2-proxy` in front of a dev Radarr, expire the session so the API path answers 302, run Test connection, and check the IdP access log for an `X-Api-Key` header.
- **CA-02 at scale:** needs a real Sonarr with 200+ series and a stopwatch on `POST /api/sync` (plus a parallel `POST /api/scan` to confirm the 409 for the whole duration). Steps: time the sync, then count requests in the Sonarr trace log — expect one `GET /api/v3/episode?seriesId=N` per series, strictly serial.
- **CA-04:** needs the gitignored fixtures (`pnpm gen:samples`) and `pnpm stub:arr`, then the README's three steps, then Re-check on a row; expect the row to vanish and the toast "the *arr no longer has this item". Blocked in this audit because the fixtures live inside the repo, which is read-only for this task.
- **CA-05/CA-06:** browser-only (`<video>` behaviour with an out-of-root src; the settings page test-then-edit line). Steps: `pnpm dev:web` + a jsdom test rather than a real browser for CA-06; a real Chrome session for the player's 404 handling.
- **Platform lanes:** the macOS JXA tray, the Windows PowerShell/VBS tray and the Linux `yad` menu are inspection-only here. Steps on each host: `pnpm start` with `CHECKARR_TRAY_SELFTEST=all` on macOS (the script supports it) and a click-through of Open/Open log/Stop on the other two.
