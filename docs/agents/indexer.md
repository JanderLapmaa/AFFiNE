# Doc indexer: how block content becomes queryable

Read this before querying blocks across docs, or before changing what the
indexer extracts.

Docs are Yjs documents. Each block is a Y.Map with `sys:flavour`, `sys:id`
and `prop:*` keys. The indexer pulls blocks out of every doc into a local
search index, so features can query blocks without opening each doc.

## Two extractors, keep them in sync

| Path   | Used by                         | Code                                                                                                                                        |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| JS     | Web (IndexedDB)                 | `packages/common/reader/src/reader.ts` (`readAllBlocksFromDoc`) → `packages/common/nbstore/src/sync/indexer/crawler.ts` (`crawlingDocData`) |
| Native | Electron, iOS, Android (SQLite) | `packages/frontend/native/nbstore/src/indexer/crawl.rs` → `affine_doc_loader::parse_doc_from_binary`                                        |

`packages/common/nbstore/src/sync/indexer/index.ts` calls the native
`doc.crawlDocData` when the storage provides it and falls back to the JS crawler.

`affine_doc_loader` is a **crates.io dependency** (`affine_doc_loader` in the
root `Cargo.toml`), not source in this repo. To change what the native path
extracts, either vendor/fork that crate or post-process its output in `crawl.rs`.

The server indexes docs separately (`packages/backend/server/src/plugins/indexer/`,
via `packages/backend/native`, also on `affine_doc_loader`).

## Schema

`packages/common/nbstore/src/storage/indexer/schema.ts`. A `block` row has
`docId`, `blockId`, `content`, `flavour`, `parentFlavour`, `parentBlockId`,
`refDocId`, `ref`, and `additional` (a JSON string that isn't indexed). Other
block props are not stored, except the task fields on todo list blocks (see
"Task fields" below).

## Re-index after any extractor or schema change

Bump the version so existing clients rebuild their index:

- IndexedDB: `indexVersion()` in `packages/common/nbstore/src/impls/idb/indexer/index.ts`
- SQLite: `NBSTORE_INDEXER_VERSION` in `packages/frontend/native/nbstore/src/indexer/mod.rs`
  (combined with `SQLITE_INDEXER_VERSION_OFFSET` in `packages/common/nbstore/src/impls/sqlite/indexer/index.ts`)

## Querying from the UI

`packages/frontend/core/src/modules/docs-search/services/docs-search.ts`
(`DocsSearchService`). Existing `watch*` methods (`watchRefsFrom`,
`watchDatabasesTo`, …) are the pattern for new reactive queries.

## Task fields (fork: Tasks view)

Both extractors add task fields to the `additional` JSON of every
`affine:list` block whose `prop:type` is `'todo'`. Other blocks are unchanged.
The block schema is unchanged too. `additional` can't be filtered at query
time, so the Tasks view queries `flavour: affine:list` (which includes bullet
and numbered lists), parses `additional` and keeps rows with
`listType: 'todo'` client-side. If that gets slow on large workspaces, add an
indexed field then (schema change plus both version bumps).

Doc-level data stays out of the index: doc order (newest doc first), trashed
and template flags come from the workspace doc metadata at query time.

| Key           | Value             | Emitted when                                                                                                             |
| ------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `listType`    | `'todo'`          | always (todo blocks only)                                                                                                |
| `checked`     | boolean           | always; `prop:checked === true`, else `false`                                                                            |
| `due`         | `'YYYY-MM-DD'`    | `prop:due` is a string matching `^\d{4}-\d{2}-\d{2}$`                                                                    |
| `priority`    | `1` \| `2` \| `3` | `prop:priority` is an integer 1-3 (0 = none, omitted)                                                                    |
| `completedAt` | epoch ms          | `prop:completedAt` is a finite number                                                                                    |
| `heading`     | string            | a heading exists above the block (rule below) and its trimmed text is non-empty                                          |
| `order`       | integer           | the block is reachable in the heading walk (below): its 0-based position among all blocks visited in that pre-order walk |

Numbers must be plain numbers: a Yjs bigint value is rejected (key omitted)
on both sides. Keys whose condition fails are omitted, never `null`. Existing keys
(`displayMode`, `noteBlockId`, ...) stay as they are.

**Heading rule:** walk the doc in pre-order from the `affine:page` block
(a block, then its `sys:children` in order, recursively). The heading of a
todo is the last `affine:paragraph` with `prop:type` `h1`-`h6` visited before
it, across notes. Its text is the plain string of `prop:text`, trimmed with the JS
`String.prototype.trim` whitespace set (the native side matches that set
exactly). If a doc has several `affine:page` blocks, start from the one with
the lowest `sys:id` (string order). A `sys:children` id with no matching block is
skipped and doesn't take an `order` position.
This is independent of each extractor's own traversal order.

**Shared fixture:** `packages/common/native/fixtures/tasks.ydoc` with
`tasks.ydoc.expected.json` (blockId → task fields). The reader spec and the
native nbstore indexer tests both assert against it, so the two extractors
can't drift.

Index versions bumped for this: IndexedDB `indexVersion()` 1 → 2 → 3,
`NBSTORE_INDEXER_VERSION` 7 → 8 → 9 (the second bump added `order`).
