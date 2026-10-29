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

## Windows desktop build (unpacked canary app)

Avoids the docs' "hoisting off" reinstall (which rewrites every
`node_modules` and disturbs a running dev setup). About 10 minutes cold.

Prerequisites on PATH: `<cargo>/bin`, **CMake** (`C:\Program Files\CMake\bin`;
the native build runs `cmake` for `opus-codec`, and neither Rust nor the VS
Build Tools install it) and a `yarn` that resolves (generate-assets and forge
spawn `yarn`; if only `node .yarn/releases/yarn-*.cjs` works, put a `yarn` /
`yarn.cmd` shim on PATH; use forward slashes inside a `.cmd` shim).

```sh
export CMAKE_POLICY_VERSION_MINIMUM=3.5   # needed with CMake 4.x for old C deps
yarn affine @affine/native build          # ~1.5 min once crates are cached
BUILD_TYPE=canary yarn affine @affine/electron generate-assets   # renderer + main/preload + assets
# populate packages/frontend/apps/electron/node_modules (see below), then:
BUILD_TYPE=canary SKIP_WEB_BUILD=1 HOIST_NODE_MODULES=1 yarn affine @affine/electron package
```

Output: `packages/frontend/apps/electron/out/canary/AFFiNE-canary-win32-x64/AFFiNE-canary.exe`
(unpacked, ~500 MB). Canary uses productName `AFFiNE-canary`, so its data
folder is `%APPDATA%\AFFiNE-canary`, separate from an official install
(`%APPDATA%\AFFiNE`).

### Runtime dependencies must be in `apps/electron/node_modules`

The main process externalises `electron-updater`, `yjs` and `semver`
(`scripts/common.ts`), and forge only packs what it finds in
`apps/electron/node_modules`. The docs get that folder from the hoisting-off
install. Without it the app packs fine but fails at launch with an error
dialog `Cannot find module 'electron-updater'`, **while the process stays
alive**, so a liveness check alone is not a valid smoke test.

Without the reinstall, build the folder by hand (gitignored, nothing in the
root `node_modules` changes):

- Copy (dereferenced) the transitive closure of the electron `dependencies`
  plus `semver` from the root `node_modules`.
- Forge's dependency walker and `forge.config.mjs` also need every
  `devDependency` to be locatable. Copy real copies of `@electron-forge/*`,
  `@electron/*`, `electron`, `electron-squirrel-startup`, `electron-log`,
  `app-builder-lib`, `builder-util-runtime` and `zod` (imported by
  `scripts/make-env.ts`); give every other devDependency (workspace packages,
  esbuild, vitest, ...) a stub dir containing only a `package.json`.
  Forge prunes devDependencies from the asar.
- A junction/symlink to the root `node_modules` does not work:
  packager re-creates it as a symlink and fails with `EPERM`.

Gotchas:

- Without `HOIST_NODE_MODULES=1`, forge's `prePackage` hook symlinks
  `node_modules` and fails with `EPERM ... symlink` unless Windows Developer
  Mode / the symlink privilege is enabled.
- The native build rewrites the header comment of
  `packages/frontend/native/index.js` and `index.d.ts` (`oxlint-disable` becomes
  `eslint-disable`). Run `git checkout` on those two files afterwards.
- Smoke test: start the exe with `--user-data-dir=<temp dir>` and
  `--enable-logging=stderr`, wait ~20s, enumerate the process's visible
  top-level windows (one `AFFiNE-canary` window and no dialog is healthy),
  read `<temp dir>/logs/main.log`, then kill it. A canary build checks the
  upstream GitHub releases for updates; that 404 in `main.log` is expected.
- Rebuilds: the stub `apps/electron/node_modules` shadows `esbuild` and breaks
  `generate-assets` (`Cannot find package '.../node_modules/esbuild/index.js'`).
  Move `apps/electron/node_modules` aside while running generate-assets, then
  move it back before `package`.
