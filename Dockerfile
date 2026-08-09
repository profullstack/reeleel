# ReelEel container image.
#
# The reason this is a Dockerfile and not a buildpack: ReelEel shells out to
# FFmpeg for every media operation — probe, proxies, thumbnails, clip and reel
# rendering. A stock Node image has no ffmpeg, so `reeleel doctor` reports a
# hard failure and nothing past import works. We install it explicitly below.
#
# Debian slim, not Alpine, on purpose: @libsql/client ships glibc prebuilt
# native binaries. On musl it would fall back to building from source or fail.

# ── Builder ─────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@11.18.0 --activate

# pnpm prompts before purging node_modules and aborts when there is no TTY,
# which is exactly the case inside a build. CI=true makes it proceed.
ENV CI=true

WORKDIR /app

# Manifests first, so a source-only change does not invalidate the install
# layer. Every workspace package needs its package.json present before
# `pnpm install` will resolve the workspace graph.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json      apps/api/
COPY apps/cli/package.json      apps/cli/
COPY apps/desktop/package.json  apps/desktop/
COPY apps/web/package.json      apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json   packages/db/
COPY packages/sports/package.json packages/sports/

RUN pnpm install --frozen-lockfile

COPY . .

# Builds every package and app, including the web client bundle (esbuild).
RUN pnpm build

# Bake the detector weights in, so detection works out of the box rather than
# needing a first-run download onto a volume. YOLOX is Apache-2.0, which is why
# it can be redistributed in an image at all — see THIRD_PARTY_LICENSES.md.
#
# Soft-failure is deliberate: an outage at the weights host should not break a
# deploy of the whole application. Without the file the worker returns an
# actionable "no model" error and `reeleel-cv fetch-model` can fetch it later.
RUN node apps/cv-worker/dist/index.js fetch-model \
      --sport soccer --output /app/models/yolox-tiny.onnx \
    || echo "WARNING: detector weights were not downloaded; detection will be unavailable"

# Drop devDependencies now that dist/ exists. pnpm rebuilds node_modules from
# the store with production deps only; the workspace symlinks are recreated and
# the built dist/ directories live outside node_modules, so they survive.
# confirmModulesPurge is belt-and-braces alongside CI=true above.
#
# Scripts deliberately run: this rebuild discards the node_modules that the
# first install populated, and onnxruntime-node's postinstall is what places
# its native binaries. Skipping it produces an image whose detector cannot
# load a model.
RUN pnpm install --frozen-lockfile --prod \
      --config.confirmModulesPurge=false

# ── Runner ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS runner

# ffmpeg provides both ffmpeg and ffprobe, which is what `reeleel doctor` looks
# for. ca-certificates is needed for Turso over TLS. gosu lets the entrypoint
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

# The whole built workspace, symlinks and all. Paths are identical to the
# builder stage, so the pnpm workspace links still resolve.
COPY --from=builder --chown=node:node /app /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /data/projects \
  && chown -R node:node /data

# No `VOLUME /data` here on purpose: Railway rejects the Dockerfile VOLUME
# instruction outright ("use Railway Volumes"). The mount is declared on the
# service instead — see README. Other runtimes can pass `-v reeleel-data:/data`.
EXPOSE 8080

# cwd is apps/web because the server resolves its static `public/` directory
# relative to the working directory.
WORKDIR /app/apps/web

# Starts as root only long enough to take ownership of a freshly mounted
# volume, then execs as `node`. See docker-entrypoint.sh.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
