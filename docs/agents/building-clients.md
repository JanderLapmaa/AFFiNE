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

## Native (Rust) on Windows

- The toolchain is pinned in `rust-toolchain.toml`; rustup installs it on
  first use. Linking needs the MSVC Build Tools **and** a Windows 10/11 SDK
  with `um\x64` libs (`LNK1181: cannot open input file 'kernel32.lib'` means
  the SDK is missing or partial).
- `cargo test -p affine_nbstore` has three tests that fail on Windows on an
  unmodified checkout, all with OS error 32 ("file in use") in their
  temp-dir cleanup: `storage::tests::vacuum_into_exports_a_compacted_database`,
  `storage::tests::validate_import_schema_accepts_initial_v2_schema`,
  `doc::tests::get_doc_reads_snapshot_and_updates_from_one_view`. They fail
  single-threaded too. Treat them as pre-existing, not as regressions.
- Don't run vitest while cargo is building: Vite's watcher crashes with
  `EBUSY` on files under `target/`.
- `vitest run packages/frontend/core` has four spec files that fail on Windows
  on an unmodified checkout: `src/__tests__/share-page.spec.ts` (Vite "Denied
  ID" on a template sticker path with `~`), the mermaid and typst
  `*-preview.integration.spec.ts` (Playwright browser not installed) and
  `src/utils/__tests__/first-app-data.spec.ts` (`localStorage` undefined).
