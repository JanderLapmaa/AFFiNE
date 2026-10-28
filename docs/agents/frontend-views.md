# Adding a feature module or a new view

Read this before adding a page, sidebar entry, mobile tab, or a new
`modules/*` feature to the app.

All UI lives in `packages/frontend/core/src/` and is shared by web, Electron
and mobile. The `packages/frontend/apps/*` packages are thin platform shells.

## Modules

`modules/<name>/` holds DI-registered features built from `Service`, `Entity`
and `Store` (`@toeverything/infra`). Each module exports a `configure*Module`
function that is wired up in `modules/index.ts`. Small, comparable modules to
copy from: `journal/`, `tag/`, `favorite/`.

Modules you will often depend on:

- `doc/`: open docs, read and write blocks
- `docs-search/`: indexer queries (see [indexer.md](indexer.md))
- `workspace/`: the current workspace and its doc list
- `navigation/`, `workbench/`: routing; `navigation/utils.ts` builds URLs
  that jump to specific `blockIds`
- `peek-view/`: open a doc in an overlay without leaving the current view
- `workspace-property/`: doc-level custom properties
- `notification/`: in-app notifications
- `feature-flag/`: gate unfinished features

## Desktop (web + Electron)

- Routes: `desktop/workbench-router.ts`; pages in `desktop/pages/workspace/`
- Sidebar entries: `components/root-app-sidebar/index.tsx` (see the Journal
  and Trash buttons); the sidebar framework is in `modules/app-sidebar/` and
  `modules/navigation-panel/`
- A list page to model on: `desktop/pages/workspace/all-page/`

## Mobile (iOS, Android, mobile web)

- Routes: `mobile/workbench-router.ts`; pages in `mobile/pages/workspace/`
- Bottom tabs: `mobile/components/app-tabs/data.tsx`

## Strings

Add UI strings to `packages/frontend/i18n/src/resources/en.json`.
