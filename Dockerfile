# ReelEel container image.
#
# The reason this is a Dockerfile and not a buildpack: ReelEel shells out to
# FFmpeg for every media operation — probe, proxies, thumbnails, clip and reel
# rendering. A stock Bun image has no ffmpeg, so `reeleel doctor` reports a
# hard failure and nothing past import works. We install it explicitly below.
#
# Debian slim, not Alpine, on purpose: @libsql/client and onnxruntime-node ship
# glibc prebuilt native binaries. On musl they would fall back to building from
# source or fail.
#
# Runtime is Bun (fleet Node -> Bun migration, 2026-10-01). The web server stays
# on @hono/node-server, which runs on Bun's node:http. The CV worker is spawned
# with process.execPath, so it runs under Bun too, onnxruntime-node included.

# ── Builder ─────────────────────────────────────────────────────────────────
FROM oven/bun:1.4.0-slim AS builder

WORKDIR /app

# Manifests first, so a source-only change does not invalidate the install
# layer. Every workspace package needs its package.json present before
# `bun install` will resolve the workspace graph.
COPY package.json bun.lock ./
COPY apps/api/package.json       apps/api/
COPY apps/cli/package.json       apps/cli/
COPY apps/cv-worker/package.json apps/cv-worker/
COPY apps/desktop/package.json   apps/desktop/
COPY apps/web/package.json       apps/web/
COPY packages/client/package.json packages/client/
COPY packages/core/package.json  packages/core/
COPY packages/db/package.json    packages/db/
COPY packages/sports/package.json packages/sports/

RUN bun install --frozen-lockfile

COPY . .

# Builds every package and app, including the web client bundle (esbuild).
RUN bun run build

# Bake the detector weights in, so detection works out of the box rather than
# needing a first-run download onto a volume. YOLOX is Apache-2.0, which is why
# it can be redistributed in an image at all — see THIRD_PARTY_LICENSES.md.
#
# Soft-failure is deliberate: an outage at the weights host should not break a
# deploy of the whole application. Without the file the worker returns an
# actionable "no model" error and `reeleel-cv fetch-model` can fetch it later.
RUN bun apps/cv-worker/dist/index.js fetch-model \
      --sport soccer --output /app/models/yolox-tiny.onnx \
    || echo "WARNING: detector weights were not downloaded; detection will be unavailable"

# Drop devDependencies now that dist/ exists. The built dist/ directories live
# outside node_modules, so they survive. Lifecycle scripts run (onnxruntime-node
# and esbuild are in trustedDependencies): onnxruntime-node's postinstall is
# part of placing its native binaries, and an image whose detector cannot load
# a model is worse than a slower build.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
  && bun install --frozen-lockfile --production

# ── Runner ──────────────────────────────────────────────────────────────────
FROM oven/bun:1.4.0-slim AS runner

# ffmpeg provides both ffmpeg and ffprobe, which is what `reeleel doctor` looks
# for. ca-certificates is needed for Postgres over TLS. gosu lets the entrypoint
# fix volume ownership as root and then drop to an unprivileged user.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates gosu \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Containers must bind every interface to be reachable. The application's own
# default stays on loopback; this is the deliberate opt-in.
ENV HOST=0.0.0.0
ENV PORT=8080
# Config, registry and cache. Mount a volume here to keep them across deploys.
ENV REELEEL_HOME=/data
ENV REELEEL_PROJECTS_DIR=/data/projects
# Detector weights baked into the image above, not on the volume.
ENV REELEEL_CV_MODEL=/app/models/yolox-tiny.onnx

WORKDIR /app

# The whole built workspace, symlinks and all (Bun's isolated linker keeps
# packages under node_modules/.bun and links each workspace to them). Paths are
# identical to the builder stage, so the links still resolve.
COPY --from=builder --chown=bun:bun /app /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /data/projects \
  && chown -R bun:bun /data

# No `VOLUME /data` here on purpose: Railway rejects the Dockerfile VOLUME
# instruction outright ("use Railway Volumes"). The mount is declared on the
# service instead — see README. Other runtimes can pass `-v reeleel-data:/data`.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

# cwd is apps/web because the server resolves its static `public/` directory
# relative to the working directory.
WORKDIR /app/apps/web

# Starts as root only long enough to take ownership of a freshly mounted
# volume, then execs as `bun` (uid 1000, the same uid node:22-slim's `node`
# user had, so existing volumes need no chown). See docker-entrypoint.sh.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "dist/index.js"]
