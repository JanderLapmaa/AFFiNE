# Doc indexer: how block content becomes queryable

Read this before querying blocks across docs, or before changing what the
indexer extracts.

Docs are Yjs documents. Each block is a Y.Map with `sys:flavour`, `sys:id`
and `prop:*` keys. The indexer pulls blocks out of every doc into a local
search index, so features can query blocks without opening each doc.

## Two extractors, keep them in sync

| Path | Used by | Code |
| --- | --- | --- |
| JS | Web (IndexedDB) | `packages/common/reader/src/reader.ts` (`readAllBlocksFromDoc`) → `packages/common/nbstore/src/sync/indexer/crawler.ts` (`crawlingDocData`) |
| Native | Electron, iOS, Android (SQLite) | `packages/frontend/native/nbstore/src/indexer/crawl.rs` → `affine_doc_loader::parse_doc_from_binary` |

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
`refDocId`, `ref`, and `additional` (a JSON string that isn't indexed). Block
props beyond text (for example list `type` and `checked`) are not stored today.

## Re-index after any extractor or schema change

Bump the version so existing clients rebuild their index:

- IndexedDB: `indexVersion()` in `packages/common/nbstore/src/impls/idb/indexer/index.ts`
- SQLite: `NBSTORE_INDEXER_VERSION` in `packages/frontend/native/nbstore/src/indexer/mod.rs`
  (combined with `SQLITE_INDEXER_VERSION_OFFSET` in `packages/common/nbstore/src/impls/sqlite/indexer/index.ts`)

## Querying from the UI

`packages/frontend/core/src/modules/docs-search/services/docs-search.ts`
(`DocsSearchService`). Existing `watch*` methods (`watchRefsFrom`,
`watchDatabasesTo`, …) are the pattern for new reactive queries.
