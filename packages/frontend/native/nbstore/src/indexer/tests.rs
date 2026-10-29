use std::path::{Path, PathBuf};

use affine_doc_loader::{ParseError, parse_doc_from_binary};
use assert_json_diff::assert_json_eq;
use chrono::Utc;
use serde_json::Value;
use tokio::fs;
use uuid::Uuid;
use y_octo::{Any, Doc, DocOptions, Map};

use super::{
  super::{DocIndexedClock, error::Error, storage::SqliteDocStorage},
  NativeCrawlResult, NativeIndexDocument, NativeIndexField, NativeIndexQuery, NativeIndexSearchOptions,
};

const DEMO_BIN: &[u8] = include_bytes!("../../../../../common/native/fixtures/demo.ydoc");
const DEMO_JSON: &[u8] = include_bytes!("../../../../../common/native/fixtures/demo.ydoc.json");
const TASKS_BIN: &[u8] = include_bytes!("../../../../../common/native/fixtures/tasks.ydoc");
const TASKS_JSON: &[u8] = include_bytes!("../../../../../common/native/fixtures/tasks.ydoc.expected.json");

fn temp_workspace_dir() -> PathBuf {
  std::env::temp_dir().join(format!("affine-native-{}", Uuid::new_v4()))
}

async fn init_db(path: &Path) -> SqliteDocStorage {
  fs::create_dir_all(path.parent().unwrap()).await.unwrap();
  let storage = SqliteDocStorage::new(path.to_string_lossy().into_owned());
  storage.connect().await.unwrap();
  storage
}

async fn cleanup(path: &Path) {
  let _ = fs::remove_dir_all(path.parent().unwrap()).await;
}

fn query(kind: &str, field: Option<&str>, value: Option<&str>) -> NativeIndexQuery {
  NativeIndexQuery {
    kind: kind.into(),
    field: field.map(Into::into),
    value: value.map(Into::into),
    occur: None,
    clauses: None,
    boost: None,
  }
}

fn options(fields: &[&str], highlights: &[&str]) -> NativeIndexSearchOptions {
  NativeIndexSearchOptions {
    limit: 10,
    offset: 0,
    fields: fields.iter().map(|value| (*value).into()).collect(),
    highlights: highlights.iter().map(|value| (*value).into()).collect(),
  }
}

fn document(id: &str, fields: &[(&str, &[&str])]) -> NativeIndexDocument {
  NativeIndexDocument {
    id: id.into(),
    fields: fields
      .iter()
      .map(|(field, values)| NativeIndexField {
        field: (*field).into(),
        values: values.iter().map(|value| (*value).into()).collect(),
      })
      .collect(),
  }
}

#[tokio::test]
async fn parse_demo_snapshot_matches_fixture() {
  let base = temp_workspace_dir();
  fs::create_dir_all(&base).await.unwrap();
  let db_path = base.join("storage.db");
  let storage = init_db(&db_path).await;
  sqlx::query(r#"INSERT INTO snapshots (doc_id, data, updated_at) VALUES (?, ?, ?)"#)
    .bind("demo-doc")
    .bind(DEMO_BIN)
    .bind(Utc::now().naive_utc())
    .execute(&storage.pool)
    .await
    .unwrap();
  sqlx::query(r#"INSERT INTO updates (doc_id, data, created_at) VALUES (?, ?, ?)"#)
    .bind("demo-doc")
    .bind(&[0, 0][..])
    .bind(Utc::now().naive_utc())
    .execute(&storage.pool)
    .await
    .unwrap();
  let result = storage.crawl_doc_data("demo-doc").await.unwrap();
  let mut expected: Value = serde_json::from_slice(DEMO_JSON).unwrap();
  let mut actual = serde_json::to_value(&result).unwrap();
  for document in [&mut expected, &mut actual] {
    for block in document["blocks"].as_array_mut().unwrap() {
      if let Some(additional) = block["additional"].as_str() {
        block["additional"] = serde_json::from_str(additional).unwrap();
      }
    }
  }
  assert_json_eq!(expected, actual);
  storage.close().await;
  cleanup(&db_path).await;
}

#[tokio::test]
async fn missing_doc_returns_error() {
  let db_path = temp_workspace_dir().join("storage.db");
  let storage = init_db(&db_path).await;
  let error = storage.crawl_doc_data("absent-doc").await.unwrap_err();
  assert!(matches!(error, Error::Parse(ParseError::DocNotFound)));
  storage.close().await;
  cleanup(&db_path).await;
}

#[tokio::test]
async fn index_tables_support_terminal_queries_and_restart() {
  let db_path = temp_workspace_dir().join("storage.db");
  let storage = init_db(&db_path).await;
  storage
    .index_upsert(
      "doc",
      document(
        "doc-1",
        &[
          ("docId", &["doc-1"]),
          ("title", &["Rust 搜索"]),
          ("summary", &["stored summary"]),
        ],
      ),
    )
    .await
    .unwrap();
  storage
    .index_upsert(
      "block",
      document(
        "block-1",
        &[
          ("docId", &["doc-1"]),
          ("blockId", &["block-1"]),
          ("content", &["hello world", "你好搜索"]),
          ("flavour", &["affine:paragraph"]),
        ],
      ),
    )
    .await
    .unwrap();
  storage
    .index_upsert(
      "block",
      document(
        "block-2",
        &[
          ("docId", &["doc-10"]),
          ("blockId", &["block-2"]),
          ("content", &["hello unrelated"]),
          ("flavour", &["affine:code"]),
        ],
      ),
    )
    .await
    .unwrap();

  let text = storage
    .index_search(
      "block",
      query("match", Some("content"), Some("搜索")),
      options(&["content"], &["content"]),
    )
    .await
    .unwrap();
  assert_eq!(text.total, 1);
  assert_eq!(text.hits[0].id, "block-1");
  assert!(!text.hits[0].highlights[0].values[0].spans.is_empty());

  let exact = storage
    .index_search(
      "block",
      query("match", Some("docId"), Some("doc-1")),
      options(&["docId"], &[]),
    )
    .await
    .unwrap();
  assert_eq!(exact.total, 1);
  assert_eq!(exact.hits[0].fields[0].values, ["doc-1"]);

  let aggregate = storage
    .index_aggregate(
      "block",
      query("all", None, None),
      "flavour",
      10,
      0,
      Some(options(&["blockId"], &[])),
    )
    .await
    .unwrap();
  assert_eq!(aggregate.total, 2);
  assert_eq!(aggregate.buckets.len(), 2);

  let clock = DocIndexedClock {
    doc_id: "doc-1".into(),
    timestamp: Utc::now().naive_utc(),
    indexer_version: SqliteDocStorage::index_version() as i64,
  };
  storage.commit_indexed_clocks(&[clock]).await.unwrap();
  storage.close().await;

  let restored = init_db(&db_path).await;
  let result = restored
    .index_search(
      "block",
      query("match", Some("content"), Some("hello")),
      options(&[], &[]),
    )
    .await
    .unwrap();
  assert_eq!(result.total, 2);
  assert_eq!(
    restored
      .index_delete_by_query("block", query("match", Some("docId"), Some("doc-1")))
      .await
      .unwrap(),
    1
  );
  restored.close().await;
  cleanup(&db_path).await;
}

#[tokio::test]
async fn corrupt_checkpoint_requires_rebuild_and_clears_clocks() {
  let db_path = temp_workspace_dir().join("storage.db");
  let storage = init_db(&db_path).await;
  storage
    .index_upsert(
      "doc",
      document("doc-1", &[("docId", &["doc-1"]), ("title", &["title"])]),
    )
    .await
    .unwrap();
  let clock = DocIndexedClock {
    doc_id: "doc-1".into(),
    timestamp: Utc::now().naive_utc(),
    indexer_version: SqliteDocStorage::index_version() as i64,
  };
  storage.commit_indexed_clocks(&[clock]).await.unwrap();
  sqlx::query("UPDATE idx_snapshots SET data = x'00' WHERE index_name = 'doc'")
    .execute(&storage.pool)
    .await
    .unwrap();
  storage.close().await;

  let restored = init_db(&db_path).await;
  assert!(matches!(
    restored
      .index_search("doc", query("all", None, None), options(&[], &[]))
      .await,
    Err(Error::IndexNotReady)
  ));
  assert!(restored.get_doc_indexed_clock("doc-1".into()).await.unwrap().is_none());
  restored
    .index_upsert(
      "doc",
      document("doc-1", &[("docId", &["doc-1"]), ("title", &["rebuilt"])]),
    )
    .await
    .unwrap();
  restored
    .commit_indexed_clocks(&[DocIndexedClock {
      doc_id: "doc-1".into(),
      timestamp: Utc::now().naive_utc(),
      indexer_version: SqliteDocStorage::index_version() as i64,
    }])
    .await
    .unwrap();
  assert_eq!(
    restored
      .index_search("doc", query("all", None, None), options(&[], &[]))
      .await
      .unwrap()
      .total,
    1
  );
  restored.close().await;
  cleanup(&db_path).await;
}

#[tokio::test]
async fn failed_atomic_commit_keeps_index_dirty_and_clock_unadvanced() {
  let db_path = temp_workspace_dir().join("storage.db");
  let storage = init_db(&db_path).await;
  storage
    .index_upsert(
      "doc",
      document("doc-1", &[("docId", &["doc-1"]), ("title", &["title"])]),
    )
    .await
    .unwrap();
  sqlx::query("DROP TABLE idx_snapshots")
    .execute(&storage.pool)
    .await
    .unwrap();
  let clock = DocIndexedClock {
    doc_id: "doc-1".into(),
    timestamp: Utc::now().naive_utc(),
    indexer_version: SqliteDocStorage::index_version() as i64,
  };
  assert!(storage.commit_indexed_clocks(&[clock]).await.is_err());
  assert!(
    storage
      .indexes
      .table("doc")
      .unwrap()
      .index
      .read()
      .await
      .has_unpersisted_changes()
  );
  assert!(storage.get_doc_indexed_clock("doc-1".into()).await.unwrap().is_none());
  storage.close().await;
  cleanup(&db_path).await;
}

const TASK_KEYS: [&str; 8] = [
  "listType",
  "checked",
  "due",
  "priority",
  "completedAt",
  "heading",
  "order",
  "refs",
];

async fn crawl_snapshot(bin: &[u8]) -> NativeCrawlResult {
  let db_path = temp_workspace_dir().join("storage.db");
  let storage = init_db(&db_path).await;
  sqlx::query(r#"INSERT INTO snapshots (doc_id, data, updated_at) VALUES (?, ?, ?)"#)
    .bind("task-doc")
    .bind(bin)
    .bind(Utc::now().naive_utc())
    .execute(&storage.pool)
    .await
    .unwrap();
  let result = storage.crawl_doc_data("task-doc").await.unwrap();
  storage.close().await;
  cleanup(&db_path).await;
  result
}

/// The parsed `additional` JSON of a block; `Null` when the block has no row or no additional.
fn additional_of(result: &NativeCrawlResult, block_id: &str) -> Value {
  let additional = result
    .blocks
    .iter()
    .find(|block| block.block_id == block_id)
    .and_then(|block| block.additional.as_deref());
  match additional {
    Some(additional) => serde_json::from_str(additional).unwrap(),
    None => Value::Null,
  }
}

/// Only the task keys of a block's `additional` JSON.
fn task_keys_of(result: &NativeCrawlResult, block_id: &str) -> Value {
  let additional = additional_of(result, block_id);
  let mut fields = serde_json::Map::new();
  if let Some(object) = additional.as_object() {
    for key in TASK_KEYS {
      if let Some(value) = object.get(key) {
        fields.insert(key.to_string(), value.clone());
      }
    }
  }
  Value::Object(fields)
}

fn add_block(doc: &Doc, blocks: &mut Map, id: &str, flavour: &str, children: &[&str], props: Vec<(&str, Any)>) {
  blocks.insert(id.to_string(), doc.create_map().unwrap()).unwrap();
  let mut block = blocks.get(id).unwrap().to_map().unwrap();
  block.insert("sys:id".to_string(), id).unwrap();
  block.insert("sys:flavour".to_string(), flavour).unwrap();
  block
    .insert("sys:children".to_string(), doc.create_array().unwrap())
    .unwrap();
  let mut array = block.get("sys:children").unwrap().to_array().unwrap();
  for child in children {
    array.push(*child).unwrap();
  }
  for (key, value) in props {
    block.insert(key.to_string(), value).unwrap();
  }
}

fn add_text(doc: &Doc, blocks: &Map, id: &str, text: &str) {
  let mut block = blocks.get(id).unwrap().to_map().unwrap();
  block
    .insert("prop:text".to_string(), doc.create_text().unwrap())
    .unwrap();
  let mut prop = block.get("prop:text").unwrap().to_text().unwrap();
  prop.insert(0, text).unwrap();
}

fn s(value: &str) -> Any {
  Any::String(value.to_string())
}

fn todo() -> (&'static str, Any) {
  ("prop:type", s("todo"))
}

/// What the shared fixture cannot cover: the external parser only emits list
/// blocks with a text prop, so a todo without text has no row to merge into.
#[tokio::test]
async fn crawl_skips_todo_without_text() {
  let doc = DocOptions::new().build();
  let mut blocks = doc.get_or_create_map("blocks").unwrap();
  add_block(&doc, &mut blocks, "page", "affine:page", &["note"], vec![]);
  add_block(
    &doc,
    &mut blocks,
    "note",
    "affine:note",
    &["t-text", "t-notext"],
    vec![],
  );
  add_block(&doc, &mut blocks, "t-text", "affine:list", &[], vec![todo()]);
  add_text(&doc, &blocks, "t-text", "text");
  add_block(&doc, &mut blocks, "t-notext", "affine:list", &[], vec![todo()]);
  let result = crawl_snapshot(&doc.encode_update_v1().unwrap()).await;
  assert_eq!(task_keys_of(&result, "t-text")["listType"], "todo");
  assert!(result.blocks.iter().all(|block| block.block_id != "t-notext"));
}

#[tokio::test]
async fn crawl_task_fields_match_shared_fixture() {
  let result = crawl_snapshot(TASKS_BIN).await;
  let expected: Value = serde_json::from_slice(TASKS_JSON).unwrap();
  let expected = expected.as_object().unwrap();
  for (block_id, fields) in expected {
    let actual = task_keys_of(&result, block_id);
    assert_eq!(&actual, fields, "{block_id}");
  }
  for block in &result.blocks {
    if !expected.contains_key(&block.block_id) {
      assert!(task_keys_of(&result, &block.block_id).as_object().unwrap().is_empty());
    }
  }
  // Keys written by the external parser are preserved next to the task keys.
  let raw = parse_doc_from_binary(TASKS_BIN.to_vec(), "task-doc".to_string()).unwrap();
  for block in &raw.blocks {
    let merged = additional_of(&result, &block.block_id);
    if let Some(Ok(Value::Object(original))) = block.additional.as_deref().map(serde_json::from_str::<Value>) {
      for (key, value) in original {
        assert_eq!(merged[&key], value, "{} key {key}", block.block_id);
      }
    }
  }
  // Integers stay integers in the JSON string (`3`, not `3.0`).
  let due = result.blocks.iter().find(|b| b.block_id == "t-due-priority").unwrap();
  assert!(due.additional.as_deref().unwrap().contains("\"priority\":3"));
}

#[tokio::test]
async fn doc_table_is_fully_readable_beyond_the_search_window() {
  // memory-indexer caps a search window at 10000 hits; aggregate buckets are
  // uncapped, which is how the JS sync reads every indexed doc.
  const DOCS: usize = 10_050;
  let db_path = temp_workspace_dir().join("storage.db");
  let storage = init_db(&db_path).await;
  for i in 0..DOCS {
    let id = format!("doc-{i}");
    storage
      .index_upsert(
        "doc",
        document(
          &id,
          &[
            ("docId", &[id.as_str()]),
            ("title", &["title"]),
            ("summary", &["summary"]),
          ],
        ),
      )
      .await
      .unwrap();
  }

  let mut window = options(&["docId"], &[]);
  window.limit = 10_001;
  assert!(
    storage
      .index_search("doc", query("all", None, None), window)
      .await
      .is_err()
  );

  let mut window = options(&["docId"], &[]);
  window.limit = 10_000;
  let search = storage
    .index_search("doc", query("all", None, None), window)
    .await
    .unwrap();
  assert_eq!(search.total as usize, DOCS);
  assert_eq!(search.hits.len(), 10_000);

  let mut hits = options(&["docId", "title", "summary"], &[]);
  hits.limit = 1;
  let aggregate = storage
    .index_aggregate("doc", query("all", None, None), "docId", u32::MAX, 0, Some(hits))
    .await
    .unwrap();
  assert_eq!(aggregate.buckets.len(), DOCS);
  assert!(aggregate.buckets.iter().all(|bucket| bucket.hits.len() == 1));
  let mut keys: Vec<_> = aggregate.buckets.iter().map(|bucket| bucket.key.clone()).collect();
  keys.sort();
  keys.dedup();
  assert_eq!(keys.len(), DOCS);

  storage.close().await;
  cleanup(&db_path).await;
}
