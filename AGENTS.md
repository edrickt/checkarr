# AGENTS.md

Checkarr is a locally hosted media integrity checker for Radarr/Sonarr: a pnpm monorepo with a Fastify/TypeScript + `node:sqlite` server, a React 19/Vite UI, and plain-Node desktop/tray launch scripts.

## Start here

Before the first broad search (`ls`, tree-wide `grep`/`glob`, or reading whole directories), read `docs/agents/codebase-map.md`. It routes common changes to exact files and lines, names the test suites and commands, and lists what not to read.

## Layout

- `apps/server/` - Fastify API, scan engine, Radarr/Sonarr sync, SQLite schema/migrations (`src/`); vitest suites (`test/`).
- `apps/web/` - React 19 + Vite + Tailwind UI (`src/`); vitest + Testing Library suites (`test/`).
- `scripts/` - start/stop/launch, per-OS desktop and tray icons, local fixtures under `scripts/dev/`.
- `docker/`, `.github/workflows/ci.yml` - packaging and the CI gates.
- `data/` - runtime state, gitignored; `docs/` - a historical audit and static assets.

## Entry points

Changes usually start at one of these:

- `apps/server/src/routes.ts` - every `/api` endpoint and its validation.
- `apps/server/src/services/scanner.ts` - scan lifecycle; `apps/server/src/services/checker.ts` - per-file verdict.
- `apps/server/src/services/sync.ts` - library sync from Radarr/Sonarr.
- `apps/server/src/db.ts` - schema and migrations.
- `apps/web/src/App.tsx` - UI shell and tabs.

## Commands

Run from the repo root. Node 23.4+ and pnpm 11 are required (`node:sqlite`).

```bash
pnpm install
pnpm dev:server        # API + built UI on http://127.0.0.1:5656
pnpm dev:web           # Vite HMR on :5173, proxies /api to :5656
pnpm typecheck         # tsc for both apps
pnpm lint              # eslint
pnpm format:check      # prettier
pnpm test              # root script tests + both app suites
pnpm build             # server tsc + web vite build
pnpm gen:samples       # sample media for local testing
pnpm stub:arr          # fake Radarr :8699 / Sonarr :8698
pnpm start             # production launcher (detached)
pnpm stop
pnpm app:install       # install desktop icon
```

One package or file: `pnpm -F @checkarr/server test`, `pnpm -F @checkarr/web test`, `pnpm -F @checkarr/server exec vitest run test/classify.test.ts`.

Developer notes: `README.md` section "For developers" (starts around line 179).

## Don't read

Skip generated, vendored and historical paths: `node_modules/`, `apps/server/dist/`, `apps/web/dist/`, `data/`, `docs/audits/`, `pnpm-lock.yaml`, and coverage output. The map has a one-line reason for each.

## Domain docs

None (no CONTEXT.md, GLOSSARY.md or ADRs). `README.md` is the behaviour spec: read its "How it works", "Verdicts" and "Security" sections before changing verdict or security logic.
