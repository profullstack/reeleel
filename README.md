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

## Deploying the web app

Deployment is **Docker**, not a buildpack, for one decisive reason: ReelEel
shells out to FFmpeg for every media operation. A stock Node image has no
`ffmpeg`, so `reeleel doctor` reports a hard failure and nothing past import
works. The [`Dockerfile`](Dockerfile) installs it explicitly.

```bash
docker build -t reeleel .
docker run --rm -p 8080:8080 -v reeleel-data:/data reeleel
```

Then check `http://localhost:8080/doctor` — ffmpeg and ffprobe should both be
green.

[`railway.json`](railway.json) selects the Dockerfile builder, a `/api/health`
healthcheck and an on-failure restart policy. Locally, `pnpm build && pnpm start`
still works without Docker if FFmpeg is on your PATH.

Notes on the image:

- **Debian slim, not Alpine.** `@libsql/client` ships glibc prebuilt native
  binaries; on musl it would fall back to building from source or fail.
- **Runs as `node`, not root**, and binds `0.0.0.0` only because a container
  must. The app's own default stays on loopback.
  [`docker-entrypoint.sh`](docker-entrypoint.sh) starts as root just long
  enough to take ownership of `/data` — platform volumes mount root-owned and
  empty, so an unprivileged process could not write to them — then execs as
  `node` via `gosu`.
- **`/data` is a volume.** `REELEEL_HOME=/data` and
  `REELEEL_PROJECTS_DIR=/data/projects` put the registry, config and projects
  there, so they survive a redeploy. Without a mounted volume the container
  filesystem is ephemeral and everything resets.

**Persistence.** Mount a volume at `/data`, and set `REELEEL_DB_URL` /
`REELEEL_DB_AUTH_TOKEN` so the machine registry lives in Turso rather than on
the container disk.

## Accounts and authentication

Local use still requires no account — the PRD says so and that stays true. What
follows applies to a *hosted* deployment.

### Accounts

Register at `/register`, confirm the emailed link, sign in at `/login`. Forgot
your password? `/forgot` sends a single-use reset link.

**Every account only ever sees its own projects.** Ownership is enforced in
`resolveProjectRoot`, not in the route handlers, because that function also
accepts a raw filesystem path — checking only in handlers would let a signed-in
user reach someone else's game by passing its directory. A project belonging to
another account reports as *not found* rather than *forbidden*, so the response
does not confirm it exists.

Projects registered by the CLI have no owner and stay invisible to accounts.

| Variable | Effect |
| --- | --- |
| `REELEEL_ALLOW_SIGNUP` | Set false to close registration once your people are in |
| `REELEEL_REQUIRE_EMAIL_VERIFICATION` | Defaults to on when email is configured, off when it isn't |

Passwords use scrypt from `node:crypto` — memory-hard, no native dependency —
with per-user salts and the cost parameters stored alongside each hash so they
can be raised later. Sessions are server-side rows keyed by a hashed secret, so
changing a password revokes every other session immediately. Verification and
reset tokens are stored only as SHA-256 hashes, are single-use, and expire (24h
and 1h). Login, registration and reset requests are throttled per client.

### The service token

`REELEEL_AUTH_TOKEN` is a separate, operator-level credential for scripts. It is
**not scoped to an account** — it sees everything on the machine.

```bash
curl -H "Authorization: Bearer $REELEEL_AUTH_TOKEN" https://your-host/api/projects
```

`Authorization: Bearer`, `X-ReelEel-Token` and `?token=` all work.

### Fail-closed

| Situation | Behaviour |
| --- | --- |
| No token, bound to loopback | **Open.** You are on your own machine. |
| Token set | Accounts or the service token. |
| No token, bound publicly | **Refuses to start.** |

That last row is the point: a server that can delete project directories should
fail loudly rather than quietly serve itself to the internet.

`/api/health` stays public so platform healthchecks pass; it discloses nothing
but a version string.

### Email

Verification and reset links are sent through [Resend](https://resend.com). Set
`RESEND_API_KEY`, `REELEEL_EMAIL_FROM` and `REELEEL_PUBLIC_URL`. **The sending
domain must be verified in Resend** or every send is rejected.

With no API key, links are written to the server log instead of being sent, and
email verification is not enforced — a self-hosted install should not need an
email account to be usable.

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
