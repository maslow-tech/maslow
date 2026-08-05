# The Brain — box app image.
#
# Multi-stage build of the pnpm monorepo that produces a slim runtime running
# ONLY apps/box (`node dist/index.js`). The box is the single Node/Hono front
# door; caddy terminates TLS in front of it, Postgres sits behind it.
#
# Base image is pinned by a specific tag here for readability. In production the
# release pipeline pins by DIGEST — the box pulls by digest, never by a
# floating tag, so a mutated `node:22-bookworm-slim` can't slip into the fleet:
#
#   FROM node:22-bookworm-slim@sha256:<digest>
#
# The CI keyless-sign/SLSA step records the built image's own
# digest; the release feed records that digest and boxes pull it.

# ---------------------------------------------------------------- base
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# corepack ships with node:22 and pins pnpm to packageManager in package.json.
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------- build
# Full install (incl. dev deps) + compile every workspace package (TS strict).
# Pinned to the native BUILD platform: the output is arch-independent JS (the
# box has no native prod deps), so we compile ONCE on amd64 instead of rerunning
# tsc+vite inside an emulated arm64 container — that emulation is what made
# multi-arch releases take ~an hour. Each arch's runtime stage below just copies
# the already-built /prod/box in.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app
COPY . /app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --recursive run build
# Produce a self-contained, production-only deployment of just the box. `pnpm
# deploy` resolves the workspace:* deps (@brain/{schema,mcp-tools,shared}) from
# their freshly-built dist and injects them into /prod/box/node_modules, so the
# runtime stage needs nothing else from the monorepo.
RUN pnpm --filter @brain/box deploy --prod --legacy /prod/box
# C1 anti-reverse-engineering: minify all first-party JS in the shipped tree
# (comments/identifiers gone, no sourcemaps; per-file in place so resolution
# and behavior are untouched). The box runs in customer accounts — raise the
# effort of reading it. Third-party node_modules are public code.
RUN node scripts/minify-dist.mjs /prod/box
# Ship the built dashboard SPA (apps/box/ui, already compiled by the recursive
# build above) so the box can serve it at the root. apps/box/ui is a
# nested workspace package, so `pnpm deploy` copies its SOURCE tree into
# /prod/box/ui — drop that (not needed at runtime) and place only the built
# vite output at /prod/box/webui (matches BRAIN_UI_DIR default ./webui). Done
# AFTER minify so the already-minified, hashed assets are left untouched.
RUN rm -rf /prod/box/ui && cp -r /app/apps/box/ui/dist /prod/box/webui

# ---------------------------------------------------------------- models
# The box's local retrieval models (embedder + reranker): weights are baked
# into the image, pinned by sha256 — they ride the signed release bundle like
# any other image bytes, and the runtime never downloads anything
# (LocalEmbedder/LocalReranker set allowRemoteModels = false).
#
# The bytes arrive via the BUILD CONTEXT (deploy/models/, populated by
# deploy/fetch-models.sh locally or the release workflow from the repo's
# `models-1` release mirror — HuggingFace 403s unauthenticated datacenter
# fetches, so the build never talks to HF). EVERY file is verified against
# the committed manifest: a corrupted mirror fails the BUILD, never a fleet.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS models
COPY deploy/models /models
COPY deploy/models.sha256 /models.sha256
RUN cd /models && sha256sum -c /models.sha256

# ---------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production
# TARGETARCH is amd64/arm64 per output platform — used below to drop the
# OTHER platforms' onnxruntime binaries (the npm package bundles them all).
ARG TARGETARCH
# The release tag, injected by release.yml — /api/v1/version and MCP
# serverInfo report it. "dev" outside a real release build.
ARG APP_VERSION=dev
ENV BRAIN_APP_VERSION=$APP_VERSION
# The box listens here; caddy is the only thing that talks to it (compose).
ENV PORT=8080
# tini gives us correct PID-1 signal handling so SIGTERM drains cleanly
# instead of being swallowed by node-as-PID-1.
# tini: PID-1 signal handling. poppler-utils + tesseract: the samgov
# attachment reader's OCR fallback for scanned PDFs (connectors/samgov-doc.ts
# shells out to pdftoppm + tesseract; absent tools degrade to a note).
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini poppler-utils tesseract-ocr tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /prod/box /app
COPY --from=models /models /app/models
ENV BRAIN_MODEL_DIR=/app/models
# onnxruntime-node bundles native binaries for every platform (that's why the
# amd64-built JS tree still works on arm64 — no compile happens at install
# time). Keep only THIS image's arch: the other platforms are ~150 MB of dead
# weight per image. `linux/${TARGETARCH/amd64/x64}` is spelled out because the
# package uses node arch names (x64/arm64), not Docker's (amd64/arm64).
RUN NODE_ARCH=$([ "$TARGETARCH" = "amd64" ] && echo x64 || echo arm64) \
  && OTHER_ARCH=$([ "$TARGETARCH" = "amd64" ] && echo arm64 || echo x64) \
  && for d in /app/node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v3; do \
       [ -d "$d" ] || continue; \
       rm -rf "$d/win32" "$d/darwin"; \
       for a in "$d"/linux/*; do [ "$(basename "$a")" = "$NODE_ARCH" ] || rm -rf "$a"; done; \
     done \
  # sharp/libvips install PER-ARCH packages (pnpm supportedArchitectures lays
  # down both linux arches at build time — that is what makes the amd64-built
  # tree work on arm64 at all); drop the other arch + darwin here.
  && rm -rf /app/node_modules/.pnpm/@img+sharp-*darwin* \
            /app/node_modules/.pnpm/@img+sharp-*linuxmusl* \
            /app/node_modules/.pnpm/@img+sharp-*linux-$OTHER_ARCH* \
            /app/node_modules/.pnpm/@img+sharp-libvips-linux-$OTHER_ARCH*
# The OAuth client registry lives here on a mounted volume; create + own it as
# `node` so a fresh named volume inherits writable ownership (Docker copies the
# image dir's perms into an empty volume on first mount).
RUN mkdir -p /var/lib/brain-oauth && chown -R node:node /var/lib/brain-oauth
# Kill-switch state (sticky-off + TOFU box_id pin) lives here on a mounted
# volume; create + own it as `node` so a fresh named volume is writable.
RUN mkdir -p /var/lib/brain-killswitch && chown -R node:node /var/lib/brain-killswitch
# Run unprivileged: the `node` user ships in the base image (uid 1000).
USER node
EXPOSE 8080
# A lightweight liveness check the orchestrator/compose can hit; mirrors the
# app's own /healthz route (apps/box/src/box.ts).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
