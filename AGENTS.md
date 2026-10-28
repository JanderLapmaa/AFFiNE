# AGENTS.md

A public fork of AFFiNE (block-based docs, whiteboard and knowledge base).
Default branch: `canary`.

## Public repo: keep personal setup out

Everything committed here is public. Write deployment examples with
placeholders (`affine.example.com`, "a self-hosted server"). Keep real domains,
hostnames, IPs, homelab/infrastructure details, credentials and personal
details out of commits, code, docs and PR text.

## Layout

Yarn monorepo (`package.json` workspaces) plus a Cargo workspace (`Cargo.toml`).

| Path | Contents |
| --- | --- |
| `blocksuite/` | Editor framework: block models (`affine/model`), block views (`affine/blocks/*`), widgets |
| `packages/common/` | Shared TS: `nbstore` (local storage, sync, indexer), `reader` (doc → blocks), `infra` (DI framework), `graphql` |
| `packages/frontend/core/` | The app UI shared by every platform |
| `packages/frontend/apps/` | Platform shells: `web`, `electron` + `electron-renderer`, `android`, `ios`, `mobile` (mobile web) |
| `packages/frontend/native/`, `mobile-native/` | Rust bindings for desktop / mobile (SQLite storage, native indexer) |
| `packages/backend/server/` | NestJS + Prisma + GraphQL server |

## Commands

Run tasks via `yarn affine <cmd>` (`yarn dev`, `yarn build`). Checks:
`yarn lint` (oxlint + oxfmt), `yarn typecheck`, `yarn test` (vitest, specs
next to code). Rust: `cargo fmt`; TOML: `taplo format`.

## Further docs

Read the matching doc before starting that kind of work:

- `docs/agents/frontend-views.md`: **adding** a page, sidebar entry, mobile tab or `modules/*` feature
- `docs/agents/indexer.md`: **querying** blocks across docs, or changing what gets indexed
- `docs/agents/building-clients.md`: **building** the Windows desktop app, the Android app or the server image
- `docs/agents/tasks-spec.md`: **implementing** the fork's Tasks (TODO) view; start here for that work
- `packages/frontend/apps/ios/AGENTS.md`: iOS shell
- `docs/BUILDING.md`, `docs/developing-server.md`: environment setup
