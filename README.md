# ReelEel

**Local-first, FOSS youth-sports video intelligence.** Import a game, point at
your kid, let ReelEel follow the action, review the suggested moments, and
export a shareable highlight reel.

Soccer is the first supported sport. Everything runs on your machine: no
account, no upload, no proprietary AI API, and CPU-only is a supported path, not
a degraded one.

> **Product principle** — ReelEel should make a cheap tripod and an ordinary
> camera feel like an automated youth-sports camera crew, without forcing
> families to upload their kids' footage to someone else's AI cloud.

---

## Status

| Area | State |
| --- | --- |
| Monorepo, storage, project model, jobs, sport plugins | **working** |
| CLI (`reeleel`) — full command surface | **working** |
| HTTP API (Hono) | **working** |
| Web app (Hono JSX SSR + client islands) | **working** |
| Moment scoring, Virtual Cameraman crop paths, FFmpeg render | **working** (needs tracks + FFmpeg installed) |
| Dataset export/import (COCO, YOLO, ReelEel JSON) | **working** |
| Detection + tracking (Python CV worker) | **contract defined, not implemented** (PRD phase 3) |
| Desktop packaging | **scaffold** (PRD phase 9) |

Without the CV worker you can still create projects, import and probe footage,
build proxies and thumbnails, mark moments yourself, trim and order clips,
assemble reels and export MP4s. What you cannot do yet is have ReelEel find the
moments for you.

## Requirements

- **Node.js 22.5+**
- **FFmpeg and ffprobe** on your `PATH` (not bundled — see
  [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md))
- pnpm 11+

Check everything at once:

```bash
reeleel doctor
```

## Quick start

```bash
pnpm install
pnpm build

# 1. make a project
reeleel project create "Spring Cup QF" --sport soccer --opponent "Rivals"

# 2. bring in the footage (referenced in place, not copied)
reeleel import ~/Videos/spring-cup-qf.mp4

# 3. say who to follow
reeleel athlete add --name "Sam" --number 7 --focal

# 4. analyze, then review
reeleel analyze --preset fast
reeleel moments list
reeleel moments update 3 --include
reeleel moments update 5 --exclude

# 5. assemble and export
reeleel clips from-moments
reeleel reel create highlights --aspect 9:16
reeleel export --reel highlights
```

Full command reference: [docs/cli.md](docs/cli.md).

The web UI covers the same review flow in a browser:

```bash
pnpm --filter @reeleel/web dev   # http://127.0.0.1:8788
```

## Repository layout

```
apps/
  cli/        @reeleel/cli      the `reeleel` command
  api/        @reeleel/api      Hono HTTP API over the core services
  web/        @reeleel/web      Hono JSX SSR pages + client islands (SPA)
  desktop/    @reeleel/desktop  native shell (scaffold, phase 9)
packages/
  core/       @reeleel/core     project model, storage, FFmpeg, jobs, scoring, datasets
  db/         @reeleel/db       libSQL/Turso clients + forward-only SQL migrations
  sports/     @reeleel/sports   sport plugins (soccer ships today)
workers/
  cv/         reeleel-cv        Python detection/tracking worker (contract only)
scripts/      db-migrate.mjs    standalone migration runner
```

Every app is a thin shell over `@reeleel/core`. That is the architectural rule
that keeps the GUI and CLI honest about being the same product — logic that
lands in an app instead of in core is logic the other surfaces silently lose.

## A project is a folder

```
my-game/
├── project.json     portable manifest (human readable, diffable)
├── project.db       libSQL: jobs, detections, tracks, moments, clips…
├── source/          imported media (referenced in place by default)
├── proxies/         low-res editing proxies
├── thumbnails/      scrub thumbnails
├── analysis/        detector/tracker intermediates
├── annotations/     human corrections and dataset exports
├── clips/           rendered clip segments
├── models/          project-pinned model copies
└── exports/         finished reels
```

Copy the folder and everything travels with it. `reeleel project import <dir>`
registers it on another machine.

## Storage: local first, Turso optional

Project databases are always **local libSQL files**. Syncing a family's game
metadata to the cloud has to be a deliberate choice, never a default.

Only the machine-wide registry (which projects and models this install knows
about) can point at Turso:

```bash
export REELEEL_DB_URL=libsql://your-db.turso.io
export REELEEL_DB_AUTH_TOKEN=...
pnpm db:migrate
```

With a remote URL set, ReelEel uses an **embedded replica** — reads stay local
and offline-safe, writes push through when there is a connection. With no URL
set, it is a plain local file and nothing touches the network.

Migrations are forward-only `.sql` files under `packages/db/migrations/`,
tracked in a `schema_migrations` table:

```bash
pnpm db:migrate          # global database
pnpm db:status           # show applied vs pending
pnpm db:migrate --scope project --path ./my-game/project.db
```

## Privacy and youth safety

These are constraints, not preferences:

- **No facial recognition.** Athletes are re-identified from jersey appearance,
  colour, number, position and track continuity. Never from faces.
- **Local by default.** Footage is referenced in place and never uploaded.
- **No unnecessary data about children.** No birthdays, schools or locations —
  the athlete record is name, number, team and jersey colour, all optional.
- **Uncertainty is shown, not hidden.** Low-confidence identity is flagged
  rather than silently attributed to the wrong player.
- **One-click deletion.** `reeleel project remove <ref> --delete-files --yes`.
- **No telemetry.** The app works without it and there is none to disable.

## Development

```bash
pnpm install
pnpm build            # build every package and app
pnpm test:run         # unit + integration tests
pnpm typecheck        # tsc across the workspace
pnpm lint

pnpm cli -- --help                 # run the CLI from source
pnpm --filter @reeleel/api dev     # API on :8787
pnpm --filter @reeleel/web dev     # web on :8788
```

Tests never include real youth footage. Fixtures are synthetic.

## License

MIT — see [LICENSE](LICENSE). Third-party components and the model/dataset
licensing policy are inventoried in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
