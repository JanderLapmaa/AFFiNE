# Fork CI and releases

The fork runs two workflows of its own. Upstream's workflows (`Build & Test`,
the release and copilot workflows, the labeler) are disabled on the fork in
the repository's Actions settings, not in the files, so merges from upstream
don't conflict. Re-enable one with `gh workflow enable <file>`.

## Fork CI (`.github/workflows/fork-ci.yml`)

Runs on every push to `canary`, on pull requests and on demand. It's the part
of upstream's `Build & Test` that covers what the fork ships: lint (oxlint,
oxfmt, actionlint, `yarn dedupe --check`), typecheck plus the i18n codegen
check, Rust fmt (nightly) and clippy, the vitest unit tests (5 shards) and the
server tests (4 shards, Postgres and Redis services).

Left out: the Playwright e2e suites, the Android emulator and iOS builds, the
copilot and search-provider server tests. Upstream's mobile Safari e2e and the
Android emulator job fail intermittently there too (runner disk space,
`detail.spec.ts` timing), and together they take ~40 minutes.

Before pushing, run what it runs locally (see `docs/agents/checks.md`). Two
checks differ from a plain local run:

- `cargo +nightly fmt --all -- --check`: CI formats with nightly `rustfmt`,
  which wraps doc comments; stable `cargo fmt` doesn't.
- clippy on Windows fails in `affine_media_capture`'s Windows-only code; CI
  runs on Linux, so check the crates you changed with `-p <crate>`.

## Fork Release (`.github/workflows/fork-release.yml`)

Started by hand: Actions → Fork Release → Run workflow, with a version such as
`0.27.5-fork.1`. The version must increase with every release, or installed
desktop apps won't update. Use `<upstream version>-fork.<n>`. It builds, in
parallel:

| Job             | Output                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| Server image    | `ghcr.io/<owner>/affine-fork:<version>`, linux/amd64, from `scripts/fork/server-image.Containerfile` |
| Windows desktop | `affine-<version>-canary-windows-x64.nsis.exe` (unsigned NSIS installer, canary build)               |
| Android         | `affine-<version>-canary-android-arm64.apk` (canary flavour, signed with the release key)            |

Then it creates the GitHub release `v<version>` with the installer, the APK
and `latest.yml`.

### Desktop updates

The desktop updater normally asks upstream's feed (`affine.pro`) for
releases, so a fork build would offer the upstream app. A build with
`AFFINE_UPDATE_REPO=<owner>/<name>` (the release workflow sets it to the
repository) reads that repository's GitHub releases instead
(`src/main/updater/affine-update-provider.ts`). It takes the newest release,
reads its `latest.yml` and picks the `.nsis.exe` asset by its file name, so
keep the `affine-<version>-canary-windows-x64.nsis.exe` naming. Local builds
without the variable still use upstream's feed.

The installer is unsigned: Windows SmartScreen warns on first install ("More
info" → "Run anyway"). Updates install without the prompt.

### Android signing

Release builds read the key from the environment
(`packages/frontend/apps/android/App/app/build.gradle`):
`AFFINE_ANDROID_KEYSTORE` (path), `AFFINE_ANDROID_KEYSTORE_PASSWORD`,
`AFFINE_ANDROID_KEY_PASSWORD`, `AFFINE_ANDROID_KEY_ALIAS`. The workflow
writes the keystore from repository secrets:

| Secret                             | Value                                      |
| ---------------------------------- | ------------------------------------------ |
| `AFFINE_ANDROID_KEYSTORE_BASE64`   | the PKCS12 keystore, base64                |
| `AFFINE_ANDROID_KEYSTORE_PASSWORD` | store password (= key password for PKCS12) |
| `AFFINE_ANDROID_KEY_ALIAS`         | key alias                                  |

Every release must be signed with the same key, or Android refuses to update
the installed app; switching keys means uninstalling, which loses the app's
local data (cloud workspaces stay on the server). Keep an offline copy of the
keystore and its password. An APK signed with a debug key can't be updated by
a release APK either; uninstall it once.

`versionCode` comes from `VERSION_CODE` (the workflow uses the run number),
so each release installs over the previous one.

### Server image

The image job copies the AFFiNE Pro license public key from
`ghcr.io/toeverything/affine:stable` (see `docs/agents/building-clients.md`)
and pushes to the repository owner's GHCR namespace with the workflow token.
Deploy it by tag, never a moving tag, and back up the database before a
deploy that brings upstream migrations.
