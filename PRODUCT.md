# PRODUCT.md

Checkarr — locally hosted media integrity checker for Radarr and Sonarr libraries.

## What it is

Checkarr syncs a Radarr/Sonarr library into a local SQLite database, decodes every
file with ffmpeg at the start, middle, and end, and reports which files are broken.
It can then delete the bad file at the \*arr and queue a replacement search — for one
file or a whole status.

## Who uses it

A self-hoster running Radarr/Sonarr on the same machine or LAN, usually opening
Checkarr after a download is reported broken, or on a periodic "is my library
healthy?" pass. They know what Radarr/Sonarr are; they do not want to learn a new
concept to operate Checkarr.

## The job

1. **See the state of the library** — how many files exist, when they were last
   checked, and what is wrong right now.
2. **Check files** — start a scan (all files, or a scoped subset), watch it run, cancel
   it if needed.
3. **Triage problems** — corrupt, suspect, and unreachable files are the product's
   reason to exist; the user must reach them and their ffmpeg findings in one or two
   steps.
4. **Fix** — delete & re-search bad files; re-search missing or purged items that are
   waiting on the \*arr.
5. **Configure once** — add \*arr sources, path mappings, concurrency, binary paths.

## Product truths that constrain the UI

- **The \*arr is the source of truth.** Every monitored movie/episode has a row even
  when no file exists. Statuses: `corrupt`, `suspect`, `unreachable`, `missing`,
  `purged`, `unchecked`, `healthy` (in that canonical severity order).
- **Every action syncs first.** Scan, sync, delete, and re-search pull the library
  from the \*arr before acting. A batch operation is exclusive: only one scan/sync/
  delete/re-search at a time, and per-file actions are refused while a scan runs.
- **`purged` means deleted and waiting for its replacement.** It is not missing and it
  is not gone from the app: the row stays until the replacement download lands and a
  sync relinks it. The user needs a way to trigger another search for it.
- **The app is local.** No auth, loopback by default, one user, desktop browser.
  No marketing surface, no onboarding funnel, no mobile app.
- **Danger is real.** Delete & re-search removes bytes from disk. Every destructive
  path requires an explicit confirmation that names the count and the scope.

## Surfaces

| Surface     | Purpose                                                        |
| ----------- | -------------------------------------------------------------- |
| Dashboard   | State of the library, the primary scan action, and triage/acts |
| Library     | Search, filter, sort, and act on every tracked file            |
| File detail | Verdict, metadata, ffmpeg findings, per-file actions, player   |
| Settings    | Sources, checker configuration, path mappings, network/server  |

## Success

The user opens the app after a bad download and knows within a few seconds what is
wrong, how many files are affected, and what to click next — without reading a
manual. A returning user can start a scan in one click. A purged item can be
searched again from the UI.

## Voice

Plain, specific, second person, sentence case. Controls name the action ("Delete &
re-search", "Scan library"); states name the condition ("4 files need attention").
Errors name the problem and the recovery. No exclamation marks, no mascots, no
decoration around destructive actions.

## Mode

Operate. Familiarity, density, and consistency beat expression. The status colors are
the only color in the product; everything else is neutral.
