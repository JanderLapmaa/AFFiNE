# Builds the fork's linux/amd64 server image locally, without CI. It builds the
# server dist, server-native and production node_modules on Linux, then packs
# the image like .github/deployment/node/Dockerfile.
#
# Context: a clean tree (`git archive HEAD`) plus the web, admin and mobile
# dist folders built beforehand. Steps: docs/agents/building-clients.md.
FROM node:22.23.4-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends clang curl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.97.1
WORKDIR /src
COPY . .
ENV CC="clang -D_BSD_SOURCE" TARGET_CC="clang -D_BSD_SOURCE"
RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    node .yarn/releases/yarn-4.18.0.cjs workspaces focus @affine/server @types/affine__env @affine/server-native
# Self-hosted servers refuse to start without the AFFiNE Pro license public key
# compiled into server-native. Pass the one the upstream image embeds (see the doc).
ARG AFFINE_PRO_PUBLIC_KEY
RUN --mount=type=cache,target=/opt/cargo/registry \
    test -n "$AFFINE_PRO_PUBLIC_KEY" && \
    cd packages/backend/native && node ../../../.yarn/releases/yarn-4.18.0.cjs build \
    && mv server-native.node server-native.x64.node
# The bundle must resolve every arch the native loader requires; only x64 is loaded on amd64.
RUN cd packages/backend/native && cp server-native.x64.node server-native.arm64.node && cp server-native.x64.node server-native.armv7.node
# affine bundle exits 0 on compile errors, so check the output exists.
RUN node .yarn/releases/yarn-4.18.0.cjs workspace @affine/server build && test -f packages/backend/server/dist/main.js
RUN --mount=type=cache,target=/root/.yarn/berry/cache \
    node .yarn/releases/yarn-4.18.0.cjs workspaces focus @affine/server --production \
    && node .yarn/releases/yarn-4.18.0.cjs workspace @affine/server prisma generate \
    && mv node_modules packages/backend/server/

FROM node:22-bookworm-slim AS assets
WORKDIR /app
COPY --from=builder /src/packages/backend/server /app
COPY ./packages/frontend/apps/web/dist /app/static
COPY ./packages/frontend/admin/dist /app/static/admin
COPY ./packages/frontend/apps/mobile/dist /app/static/mobile
RUN apt-get update && \
  apt-get install -y --no-install-recommends openssl ca-certificates && \
  rm -rf /var/lib/apt/lists/*
RUN AFFINE_DOCKER_CLEAN=1 TARGETARCH=amd64 node ./scripts/docker-clean.mjs

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=assets /app /app
RUN apt-get update && \
  apt-get install -y --no-install-recommends openssl libjemalloc2 ca-certificates && \
  rm -rf /var/lib/apt/lists/*
ENV LD_PRELOAD=libjemalloc.so.2
EXPOSE 3010
CMD ["sh", "-c", "node ./scripts/upgrade-config.js && exec node ./dist/main.js"]
