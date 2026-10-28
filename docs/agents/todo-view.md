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
- TODOs have no due date, priority or reminder. Adding any of those means new
  block props (stored in the Yjs doc and synced) or a side store keyed by
  `docId:blockId`.

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
