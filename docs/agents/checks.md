# Checks: inner loop vs phase gate

Run the cheap, scoped checks after every edit and the full ones once per phase.
`yarn` may not be on PATH; use `node .yarn/releases/yarn-4.18.0.cjs <cmd>` (the
commands below use `yarn` for brevity).

## Inner loop (after each edit)

```sh
yarn check:changed --skip test     # lint + types (+ rust) on uncommitted files: ~10 s
node_modules/.bin/vitest run <spec or module dir>   # the tests you touched: ~40-60 s (startup)
yarn check:changed                 # same files, plus `vitest related` (slow, see below)
yarn check:changed --branch        # everything changed vs merge-base with canary
```

Prefer naming the spec. `vitest related` follows imports, and anything reachable
from `modules/index.ts` pulls in most of frontend core (~3 min for one file in
`modules/tasks`). On Windows the script skips the known-failing cargo tests and
spec files listed below.

`scripts/check-changed.mjs` runs: `oxfmt --check` and `oxlint --deny-warnings`
on the changed files, `tsc -b` on the nearest `tsconfig.json` of each changed
`.ts(x)`, `cargo test -p <crate>` for changed `.rs` files, then
`vitest related --run` for changed TS under `packages/{common,frontend}`
(cargo always runs before vitest, never together). It does not change what
`yarn lint`, `yarn typecheck` or CI do.

By hand, even cheaper:

| Need                      | Command                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| Typecheck one project     | `node_modules/.bin/tsc -b packages/frontend/core/tsconfig.json`                               |
| Lint / format a few files | `node_modules/.bin/oxlint --deny-warnings <files>`; `node_modules/.bin/oxfmt --check <files>` |
| One spec file             | `node_modules/.bin/vitest run <path>`                                                         |
| Rust subset               | `cargo test -p affine_nbstore indexer::`                                                      |

## Pre-commit hook

The hook runs only `lint-staged` (oxfmt + `oxlint --fix` on staged files). The
fork dropped upstream's extra whole-repo `yarn lint:ox` from it (~170 s per
commit); the full lint stays in `yarn lint`, CI and the phase gate. The hook
needs `yarn` on PATH (see the shim note).

## Phase gate (end of a phase, before handing over)

`yarn typecheck`, `yarn lint`, `yarn test` (or `vitest run packages/frontend/core`),
`cargo test -p <crate>`, and only then any desktop packaging
(`docs/agents/building-clients.md`). Do not run these after every small fix.

## Measured times (Windows 11, warm caches unless noted)

| Step                                                             | Time                                      |
| ---------------------------------------------------------------- | ----------------------------------------- |
| `tsc -b tsconfig.json` (native `tsc` 7.x), no changes            | ~1.5-2.5 s                                |
| same after editing one file in `modules/tasks`                   | ~4 s                                      |
| same after `touch`ing `i18n-generated.ts` or native `index.d.ts` | ~1.5-3 s (content-hash based, no rebuild) |
| `tsc -b` with `--force` (cold, all projects)                     | ~35 s                                     |
| `tsc -b packages/frontend/core/tsconfig.json`                    | ~2.8 s                                    |
| `oxfmt --check` on a few files / on the whole repo               | 0.3 s / 1.7 s                             |
| `oxlint --deny-warnings` on 6 files (type-aware)                 | ~4 s warm, ~30 s first run                |
| `oxlint --deny-warnings` on the whole repo                       | ~170 s                                    |
| `vitest run packages/frontend/core/src/modules/tasks`            | 55-90 s, of which tests are 0.2 s         |
| `cargo test -p affine_nbstore` / `... indexer::`                 | ~12 s / ~2 s                              |

Takeaways: the TypeScript compiler is already native and incremental, so
`yarn typecheck` is not the slow step. Vitest has a ~40-55 s startup floor on
this machine that is independent of the test count (it comes from the shared
`setupFiles`/plugin loading, and is aggravated by real-time antivirus scanning
of `node_modules`), so batch spec runs: run several specs in one invocation,
not one per edit. Whole-repo `oxlint` is the slowest lint step; use it only at
the gate. `--pool=threads` and `--no-isolate` did not help.

## Known failures on an unmodified Windows checkout

- `cargo test -p affine_nbstore`: three tests fail with OS error 32 ("file in
  use") in temp-dir cleanup, also single-threaded:
  `storage::tests::vacuum_into_exports_a_compacted_database`,
  `storage::tests::validate_import_schema_accepts_initial_v2_schema`,
  `doc::tests::get_doc_reads_snapshot_and_updates_from_one_view`. They are
  flaky (sometimes two of three). Treat as pre-existing.
- `vitest run packages/frontend/core`: four spec files fail:
  `src/__tests__/share-page.spec.ts` (Vite "Denied ID" on a `~` path), the
  mermaid and typst `*-preview.integration.spec.ts` (Playwright browser not
  installed) and `src/utils/__tests__/first-app-data.spec.ts` (`localStorage`
  undefined).
- `oxfmt --check .` reports `AGENTS.md` and `docs/agents/tasks-ui-prototype.html`.
- `vitest` can print "something prevents Vite server from exiting" after all
  tests pass; that is a 10 s shutdown delay, not a test failure.

## Gotchas

- Never run vitest while cargo is building: Vite's watcher crashes with `EBUSY`
  on files under `target/`.
- The native build (`yarn affine @affine/native build`) rewrites the tracked
  `packages/frontend/native/index.js` and `index.d.ts`. Check `git status`
  afterwards and `git checkout` them unless the change is intended.
- The pre-commit hook (`.husky/pre-commit`) runs `yarn lint-staged` and
  `yarn lint:ox`, so it needs a working `yarn` on PATH. If only the `node
.yarn/releases/...` form works, put a `yarn` / `yarn.cmd` shim on PATH (use
  forward slashes in a `.cmd` shim). `yarn lint:ox` lints the whole repo, so a
  commit takes minutes on Windows.
- `i18n-generated.ts` is gitignored and regenerated by `yarn affine @affine/i18n build`;
  `tsc -b` compares content hashes, so regenerating identical output is free.
