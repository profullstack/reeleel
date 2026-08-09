# @reeleel/desktop

The packaged desktop app for Windows 11+, macOS (Apple Silicon first) and
Ubuntu 24.04+. **Scaffold only** — this is PRD phase 9 (hardening and
packaging), and nothing here ships yet.

## Why it is a thin shell

The desktop app is deliberately not where features live. `@reeleel/core` already
owns the project model, SQLite/libSQL storage, FFmpeg process management, jobs,
the sport plugin system and dataset I/O; `@reeleel/web` already renders the whole
UI with Hono JSX. The desktop build's job is to wrap those in a native window
and add the things only a native app can do:

- native filesystem pickers for importing footage
- OS notifications when a long analysis finishes
- a real "reveal in Finder/Explorer" for exports
- installers, code signing and auto-update
- keeping the local API bound to loopback, never to a public interface

That split is what keeps the promise in the PRD — GUI and CLI use the same
underlying services — from quietly rotting. A feature that lands only in the
desktop app is a feature the CLI silently lost.

## Shape when it is built

```
window (native shell)
   └── loads http://127.0.0.1:<port>  ← @reeleel/web (Hono JSX SSR + islands)
            └── @reeleel/api          ← same process
                 └── @reeleel/core    ← SQLite/libSQL, FFmpeg, jobs, CV worker
```

The runtime wrapper is not chosen yet. Whatever it is must be FOSS, must build
for all three platforms, and must not require bundling a second browser engine
per platform if avoidable.

## Until then

Everything works today without a desktop build:

```bash
pnpm --filter @reeleel/web dev   # the full UI at http://127.0.0.1:8788
reeleel --help                   # the same services, scriptable
```
