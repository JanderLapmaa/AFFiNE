# Building the fork's clients and server

Read this before building or shipping the fork. Store and official builds
don't contain fork changes, so every client the fork targets is built from
this repo.

The fork's target clients are the **Windows desktop app** and the **Android
app**, both connected to a self-hosted server.

## Windows desktop (Electron)

Shell: `packages/frontend/apps/electron` (main/preload) +
`packages/frontend/apps/electron-renderer` (UI). Steps, including the Windows
section: `docs/building-desktop-client-app.md`.

## Android (Capacitor)

Shell: `packages/frontend/apps/android`, with native storage in
`packages/frontend/mobile-native`. Setup and build steps:
`packages/frontend/apps/android/README.md`. The result is installed on the
device directly (sideloaded APK).

## Server and web

The server image (`.github/deployment/node/Dockerfile`) bundles
`apps/web/dist`, `admin/dist` and `apps/mobile/dist` as static files. Web UI
changes reach a self-hosted server only through an image built from this fork,
used in place of `ghcr.io/toeverything/affine:stable` in
`.docker/selfhost/compose.yml`. Server dev setup: `docs/developing-server.md`.
