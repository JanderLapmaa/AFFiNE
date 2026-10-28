# Fork feature: cross-doc TODO view

Read this when working on the task-management view. The implementation spec
is [tasks-spec.md](tasks-spec.md).

## Goal

TODO checkboxes written anywhere (meeting notes, any page) are easy to forget
because they stay inside their doc. The fork adds a **separate,
TickTick-style task view** that collects every TODO from every doc in the
workspace. Toggling a TODO there updates the source doc. Docs, editing and
share links keep working as before.

It must work in the fork's target clients: Windows desktop and Android (see
[building-clients.md](building-clients.md)).

## What a TODO is in the data model

A TODO is a list block with `type: 'todo'`, not a block type of its own:

- Model: `blocksuite/affine/model/src/blocks/list/list-model.ts`. Flavour
  `affine:list`, props `type` (`'bulleted' | 'numbered' | 'todo' | 'toggle'`),
  `checked`, `text`, plus `meta:createdAt/By` and `meta:updatedAt/By`.
- Editor behaviour: `blocksuite/affine/blocks/list/src/` (`list-block.ts`,
  `commands/`, `list-keymap.ts`, `markdown.ts` for the `[ ]` shortcut, `adapters/`).
- Task props (this fork): optional `due` (`'YYYY-MM-DD'`), `priority` (0-3)
  and `completedAt` (epoch ms) on the list block. See below.

## Task props: storage findings

Checked by `blocksuite/affine/all/src/__tests__/list/list-todo-roundtrip.unit.spec.ts`.

- **Unmodified clients keep the props.** Stock AFFiNE clients load, edit
  (text, toggle, type change, indent/move) and sync docs without touching
  unknown `prop:*` keys, and their snapshots include them.
- **AFFiNE-format export/import and copy/paste keep them** (snapshots are built
  from the Y.Map keys, not the schema).
- **Markdown, HTML and plain-text export drop them** (only `[ ]`/`[x]`
  survives). Accepted by the user.
- **Schema version stays 1.** The store has no migrations, and earlier additive
  props (`textAlign`, `comments`) didn't bump it.
- **`checked` is the source of truth, not `completedAt`.** An unmodified client
  that unchecks leaves a stale `completedAt`, one that checks sets none, and
  imported/pasted `[x]` todos get none (completion time unknown). Consumers
  need a fallback order for checked tasks without `completedAt`.
- **Write `checked` through `setTodoChecked`** (list block package), never a
  bare `updateBlock`: `store.updateBlock` ignores `undefined` values, so it
  can't clear `completedAt`. `getTodoCheckedProps` (model package) is the
  `addBlock` variant.

## Touch points

1. **Find TODOs across docs.** Use the indexer. It must carry list `type` and
   `checked` on both extractors (JS and native). See [indexer.md](indexer.md).
2. **The view.** A new `modules/<todo>/` plus a desktop route, a sidebar entry
   and a mobile tab. See [frontend-views.md](frontend-views.md).
3. **Jump to and toggle the source.** Open the doc at the block via
   `navigation/utils.ts` (`blockIds`) or `peek-view/`; write `checked`
   through the `doc/` module.
4. **Reminders (optional, server-side).** `packages/backend/server/src/core/notification/`
   (service + job queue) and `plugins/calendar/` (an existing cron) are the
   references. New API goes in `schema.gql` / `packages/common/graphql`.
