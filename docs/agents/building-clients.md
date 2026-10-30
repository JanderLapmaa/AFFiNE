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

The fork's `canary` flavour has its own application ID, `app.affine.pro.canary`,
and its launcher label is "AFFiNE Canary". So it installs next to the official
Play Store app (`app.affine.pro`, signed with a different key); installing over
that app fails with `INSTALL_FAILED_VERSION_DOWNGRADE`. The two apps keep
separate data, so sign in to the server again in the canary app. Both handle
`affine://` sign-in links, so Android may ask which app to open. The Capacitor
`appId` and the Kotlin namespace stay `app.affine.pro`.

### Android build on Windows (canary arm64 debug APK)

About 15 minutes cold, most of it Gradle and the Rust build of
`mobile-native`.

Prerequisites:

- Android Studio. Its SDK Manager needs **SDK Platform 36** (the app's
  `compileSdk`, from `App/gradle/libs.versions.toml`), **Build-Tools 36** and
  **NDK (Side by side)**. `App/app/build.gradle` uses the last folder in
  `<sdk>/ndk`.
- The Rust target: `rustup target add aarch64-linux-android`.
- A real `python3` on PATH. The cargo linker wrapper calls `python3`, and on
  Windows that name is usually the Microsoft Store stub. Put a folder with
  `python3.exe` (a copy of `python.exe`) first on PATH. The `rust.pythonCommand`
  property has no effect on this.
- `App/local.properties`: set `sdk.dir`, plus `rust.cargoCommand` and
  `rust.rustcCommand` pointing at the `cargo.exe` and `rustc.exe` in
  `<cargo home>/bin`. The file is gitignored.
- `App/app/google-services.json`: copy the CI stub from
  `.github/workflows/build-test.yml`. The file is gitignored. The plugin
  matches its client entry by package name, so the stub must list
  `app.affine.pro.canary` to build the canary flavour.

```sh
export JAVA_HOME="<Android Studio>/jbr" ANDROID_HOME="<sdk>" CARGO_HOME="<cargo home>"
export CMAKE_POLICY_VERSION_MINIMUM=3.5 BUILD_TYPE=canary PUBLIC_PATH=/
yarn affine @affine/android build     # web bundle, ~1 min
yarn affine @affine/android cap sync
cd packages/frontend/apps/android/App && ./gradlew.bat assembleCanaryDebug
```

From Git Bash, also set `MSYS2_ENV_CONV_EXCL='*'`. Without it, MSYS rewrites
`PUBLIC_PATH=/` to the Git install folder, and the app shows a white screen.
PowerShell (`$env:PUBLIC_PATH = '/'`) doesn't have this problem.

The build targets arm64 by default (`AFFINE_ANDROID_NATIVE_TARGET`). The
output is `App/app/build/outputs/apk/canary/debug/app-canary-debug.apk`
(~150 MB, debug-signed).

After a Rust change, delete `merged_jni_libs`, `merged_native_libs` and
`stripped_native_libs` under `App/app/build/intermediates` before
`assembleCanaryDebug`. Otherwise Gradle can package the previous
`libaffine_mobile_native.so`, even though a newer one was built. To check,
compare the `.so` size in `unzip -l <apk>`, or read the native index version
on the device (`NbStoreDocStorage.indexVersion()`, which is
`NBSTORE_INDEXER_VERSION` plus 1 on Android).

The build rewrites the tracked
`App/app/src/main/java/uniffi/affine_mobile_native/affine_mobile_native.kt`
(whitespace only). Run `git checkout` on that file afterwards.

### Testing the APK on the emulator

An x86_64 Google Play system image from API 30 up lists `arm64-v8a` in
`ro.product.cpu.abilist` and runs the arm64 APK through ARM translation, so
there's no need for a separate x86_64 build. The emulator uses WHPX on
Windows (`emulator -accel-check`).

```sh
emulator -list-avds                    # use the name exactly as listed (e.g. Medium_Phone_API_37.0)
emulator -avd <name> -no-snapshot-load -no-boot-anim &
adb wait-for-device && adb shell getprop sys.boot_completed   # 1 when booted (~60 s)
adb install -r <apk> && adb shell monkey -p app.affine.pro -c android.intent.category.LAUNCHER 1
```

- **Driving the UI:** the debug build's WebView can be debugged. Find the
  socket with `adb shell cat /proc/net/unix | grep webview_devtools_remote`,
  then run `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`.
  `http://127.0.0.1:9222/json` lists the pages; a small Node script can send
  `Runtime.evaluate` over CDP to read the DOM, click and clear localStorage.
  Keep real `adb shell input tap` for anything where tap behaviour is under
  test.
- **Screenshots:** run `adb shell screencap -p /sdcard/s.png`, then
  `adb pull`. In PowerShell, don't redirect `exec-out` with `>`; it corrupts
  the PNG.
- `adb shell input text` drops characters; type through CDP instead.
- **App restarts:** with a 2 GB AVD the app can die from memory pressure
  without a crash log. Relaunch it and redo `adb forward` for the new pid.
- **Test data:** use a local workspace, unless the test is about cloud sync.
  For that, run the server locally (`yarn affine @affine/server dev`, port
  3010), then run `adb reverse tcp:3010 tcp:3010`. In the app, connect to
  `http://localhost:3010` and sign in as the seeded dev user. The web dev
  client on `localhost:8080` proxies to the same server and can act as the
  second device.
- **Git Bash:** set `MSYS2_ARG_CONV_EXCL='*'` for `adb shell` commands.
  Without it, MSYS rewrites `/sdcard/...` into a Windows path. Gradle also
  rejects a `/c/...` `JAVA_HOME`, so use a Windows path
  (`C:\Program Files\Android\Android Studio\jbr`).
- **Typing:** to type into the WebView, tap the field, then send CDP
  `Input.insertText`. Setting an input's value from JS can hit a different
  input.

## Server and web

The server image (`.github/deployment/node/Dockerfile`) bundles
`apps/web/dist`, `admin/dist` and `apps/mobile/dist` as static files. Web UI
changes reach a self-hosted server only through an image built from this fork,
used in place of `ghcr.io/toeverything/affine:stable` in
`.docker/selfhost/compose.yml`. Server dev setup: `docs/developing-server.md`.

### Building the server image locally (Podman, linux/amd64)

About 15 minutes cold, most of it the Rust build of `server-native`. The
frontend bundles are plain JS and are built on Windows. Everything that
compiles or installs native modules runs inside the container
(`scripts/fork/server-image.Containerfile`).

```sh
# from Git Bash; MSYS2_ENV_CONV_EXCL='*' as for the Android build
for p in web admin mobile; do BUILD_TYPE=stable yarn affine @affine/$p build; done
mkdir <ctx> && git archive HEAD | tar -x -C <ctx>
# copy packages/frontend/apps/web/dist, admin/dist, apps/mobile/dist into the same paths under <ctx>
podman run --rm --entrypoint node ghcr.io/toeverything/affine:stable -e '
  const b = require("fs").readFileSync("dist/server-native.x64.node", "latin1");
  const s = b.indexOf("-----BEGIN PUBLIC KEY-----"), e = "-----END PUBLIC KEY-----";
  process.stdout.write(b.slice(s, b.indexOf(e, s) + e.length));' > pro-public-key.pem
podman build --build-arg AFFINE_PRO_PUBLIC_KEY="$(cat pro-public-key.pem)" \
  -f scripts/fork/server-image.Containerfile -t affine-fork:<tag> <ctx>
```

A self-hosted server refuses to start ("AFFINE_PRO_PUBLIC_KEY must be
embedded in self-hosted server-native builds") unless the AFFiNE Pro license
public key is compiled into `server-native`. Upstream CI injects it from a
secret. The command above copies it from the upstream image, so license
checks behave as they do on an official server. The debug key in
`native/src/lib.rs` is only compiled into debug builds, and it doesn't
validate official licenses.

`git archive` keeps the Windows `node_modules`, `target` and the Windows
`server-native.node` out of the context. Any change to the context (the
Containerfile included) invalidates the `COPY . .` layer and rebuilds the
Rust crate.

Gotchas:

- `affine bundle` exits 0 even when rspack reports errors, so the
  Containerfile checks that `dist/main.js` exists. The bundle needs all three
  arch files that `packages/backend/native/index.js` requires; the
  Containerfile copies the x64 build to the other two names (only x64 is ever
  loaded on amd64).
- The bundle inlines only the workspace packages listed for `@affine/server`
  in `tools/utils/src/workspace.gen.ts`. After adding a workspace dependency
  to the server, run `yarn affine init` and commit the regenerated file.
  Otherwise the image fails at startup with `ERR_MODULE_NOT_FOUND`, while
  `yarn affine @affine/server dev` (run from source) works fine.
- Smoke test: on a Podman network with throwaway `pgvector/pgvector:pg16` and
  `redis` containers, run the image with
  `node ./scripts/self-host-predeploy.js` (migrations plus data migrations,
  as the self-host compose does), then start it and request `/info` and
  `/graphql`.

To get the image onto the server, push it to a registry the server can pull
from, or `podman save` it and `docker load` it there.

## Native (Rust) on Windows

- The toolchain is pinned in `rust-toolchain.toml`; rustup installs it on
  first use. Linking needs the MSVC Build Tools **and** a Windows 10/11 SDK
  with `um\x64` libs (`LNK1181: cannot open input file 'kernel32.lib'` means
  the SDK is missing or partial).
- Known Windows-only test failures (cargo and vitest) and the rule about not
  running vitest during cargo builds: see `docs/agents/checks.md`.

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

Without the reinstall, build the folder with
`node scripts/fork/stage-electron-node-modules.mjs <dir outside the repo>`
(gitignored, nothing in the root `node_modules` changes). It does the
following:

- Copy (dereferenced) the transitive closure of the electron `dependencies`
  plus `semver` from the root `node_modules`.
- Forge's dependency walker and `forge.config.mjs` also need every
  `devDependency` to be locatable. Copy real copies of `@electron-forge/*`,
  `@electron/*`, `electron`, `electron-squirrel-startup`, `electron-log`,
  `app-builder-lib`, `builder-util-runtime` and `zod` (imported by
  `scripts/make-env.ts`); give every other devDependency (workspace packages,
  esbuild, vitest, ...) a stub dir containing only a `package.json`.
  Forge prunes devDependencies from the asar.
- Forge's walker also follows packages nested in a package's own
  `node_modules` (e.g. `@electron/asar/node_modules/glob`), so their
  dependencies have to be in the closure too. Otherwise it fails with
  `Failed to locate module "fs.realpath"`.
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
- The updater downloads the **upstream** canary release into
  `<user data>/pending`. It doesn't install it on quit
  (`autoInstallOnAppQuit = false`), but accepting the in-app update prompt
  would install the upstream app, without the fork's changes. Turn off
  automatic update checks in the app's settings.
- Rebuilds: the stub `apps/electron/node_modules` shadows `esbuild` and breaks
  `generate-assets` (`Cannot find package '.../node_modules/esbuild/index.js'`).
  It also breaks `vitest` (stub `rxjs` etc. resolve for electron specs). Keep
  that folder **outside the repo** and move it into `apps/electron/` only for
  the `package` step, then move it out again.
