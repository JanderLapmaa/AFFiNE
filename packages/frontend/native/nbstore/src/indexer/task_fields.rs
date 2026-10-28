//! Task fields for todo list blocks (fork: Tasks view).
//!
//! `affine_doc_loader` does not know about task props, so the crawler
//! post-processes its output: the merged doc is loaded again with `y_octo`
//! and the fields described in `docs/agents/indexer.md` ("Task fields") are
//! merged into the `additional` JSON of every todo `affine:list` block.

use std::collections::{HashMap, HashSet};

use serde_json::{Map as JsonMap, Number, Value as JsonValue};
use y_octo::{Any, Doc, DocOptions, Map, Value};

use super::NativeBlockInfo;

const FLAVOUR_PAGE: &str = "affine:page";
const FLAVOUR_LIST: &str = "affine:list";
const FLAVOUR_PARAGRAPH: &str = "affine:paragraph";

type TaskFields = JsonMap<String, JsonValue>;

/// Merge collected task fields into the `additional` JSON of todo list blocks.
pub(super) fn merge_task_fields(fields: &HashMap<String, TaskFields>, blocks: &mut [NativeBlockInfo]) {
  if fields.is_empty() {
    return;
  }
  for block in blocks.iter_mut() {
    let Some(task) = fields.get(&block.block_id) else {
      continue;
    };
    let mut object = match block.additional.as_deref().map(serde_json::from_str::<JsonValue>) {
      Some(Ok(JsonValue::Object(object))) => object,
      _ => JsonMap::new(),
    };
    for (key, value) in task {
      object.insert(key.clone(), value.clone());
    }
    block.additional = Some(JsonValue::Object(object).to_string());
  }
}

/// blockId -> task fields, for every todo list block in the doc.
pub(super) fn collect_task_fields(doc_bin: &[u8]) -> Option<HashMap<String, TaskFields>> {
  if doc_bin.is_empty() || doc_bin == [0, 0] {
    return None;
  }
  let mut doc: Doc = DocOptions::new().build();
  doc.apply_update_from_binary_v1(doc_bin).ok()?;
  let blocks = doc.get_map("blocks").ok()?;

  // With several pages, start from the lowest `sys:id` (string order).
  let page_id = blocks
    .iter()
    .filter(|(_, value)| {
      value
        .to_map()
        .is_some_and(|block| string_prop(&block, "sys:flavour").as_deref() == Some(FLAVOUR_PAGE))
    })
    .map(|(id, _)| id.to_string())
    .min();

  let mut result = HashMap::new();
  let mut visited = HashSet::new();
  let mut heading = None;
  if let Some(page_id) = page_id {
    walk(&blocks, &page_id, &mut visited, &mut heading, &mut result);
  }
  // Todo blocks not reachable from the page still get the non-heading fields.
  for (id, value) in blocks.iter() {
    if visited.contains(id) {
      continue;
    }
    if let Some(fields) = value.to_map().and_then(|block| todo_fields(&block, None)) {
      result.insert(id.to_string(), fields);
    }
  }
  Some(result)
}

/// Iterative pre-order walk over `sys:children` (no recursion, so deep trees
/// cannot overflow the stack); the heading is the text of the last h1-h6
/// paragraph visited so far.
fn walk(
  blocks: &Map,
  root: &str,
  visited: &mut HashSet<String>,
  heading: &mut Option<String>,
  result: &mut HashMap<String, TaskFields>,
) {
  let mut stack = vec![root.to_string()];
  while let Some(id) = stack.pop() {
    if !visited.insert(id.clone()) {
      continue;
    }
    let Some(block) = blocks.get(&id).and_then(|value| value.to_map()) else {
      continue;
    };
    match string_prop(&block, "sys:flavour").as_deref() {
      Some(FLAVOUR_PARAGRAPH) => {
        let kind = string_prop(&block, "prop:type").unwrap_or_default();
        if matches!(kind.as_str(), "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
          let text = string_prop(&block, "prop:text").unwrap_or_default();
          *heading = Some(js_trim(&text).to_string());
        }
      }
      Some(FLAVOUR_LIST) => {
        if let Some(fields) = todo_fields(&block, heading.as_deref()) {
          result.insert(id.clone(), fields);
        }
      }
      _ => {}
    }
    let children: Vec<String> = block
      .get("sys:children")
      .and_then(|value| value.to_array())
      .map(|array| array.iter().filter_map(|value| value_to_string(&value)).collect())
      .unwrap_or_default();
    // Reversed, so the first child is popped first.
    stack.extend(children.into_iter().rev());
  }
}

/// `String.prototype.trim`: the ECMAScript WhiteSpace and LineTerminator sets.
/// Unlike `str::trim` this excludes U+0085 and includes U+FEFF.
fn js_trim(text: &str) -> &str {
  text.trim_matches(|c: char| {
    matches!(
      c,
      '\u{9}'..='\u{d}'
        | '\u{20}'
        | '\u{a0}'
        | '\u{1680}'
        | '\u{2000}'..='\u{200a}'
        | '\u{2028}'
        | '\u{2029}'
        | '\u{202f}'
        | '\u{205f}'
        | '\u{3000}'
        | '\u{feff}'
    )
  })
}

fn todo_fields(block: &Map, heading: Option<&str>) -> Option<TaskFields> {
  if string_prop(block, "sys:flavour").as_deref() != Some(FLAVOUR_LIST)
    || string_prop(block, "prop:type").as_deref() != Some("todo")
  {
    return None;
  }
  let mut fields = TaskFields::new();
  fields.insert("listType".into(), JsonValue::String("todo".into()));
  let checked = matches!(any_prop(block, "prop:checked"), Some(Any::True));
  fields.insert("checked".into(), JsonValue::Bool(checked));
  if let Some(due) = string_prop(block, "prop:due").filter(|due| is_due_date(due)) {
    fields.insert("due".into(), JsonValue::String(due));
  }
  if let Some(priority) = any_prop(block, "prop:priority")
    .as_ref()
    .and_then(as_f64)
    .filter(|priority| priority.fract() == 0.0 && (1.0..=3.0).contains(priority))
  {
    fields.insert("priority".into(), JsonValue::from(priority as u8));
  }
  if let Some(completed_at) = any_prop(block, "prop:completedAt")
    .as_ref()
    .and_then(as_f64)
    .and_then(json_number)
  {
    fields.insert("completedAt".into(), JsonValue::Number(completed_at));
  }
  if let Some(heading) = heading.filter(|heading| !heading.is_empty()) {
    fields.insert("heading".into(), JsonValue::String(heading.to_string()));
  }
  Some(fields)
}

/// `^\d{4}-\d{2}-\d{2}$` (ASCII digits only).
fn is_due_date(value: &str) -> bool {
  let bytes = value.as_bytes();
  bytes.len() == 10
    && bytes.iter().enumerate().all(|(index, byte)| match index {
      4 | 7 => *byte == b'-',
      _ => byte.is_ascii_digit(),
    })
}

/// Finite numbers only. JS numbers arrive as `Integer`, `Float32` or
/// `Float64` (`BigInt64` is rejected, as on the JS side); whole values are emitted as JSON integers, as `JSON.stringify`
/// does on the JS side.
fn json_number(value: f64) -> Option<Number> {
  if !value.is_finite() {
    return None;
  }
  if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
    Some(Number::from(value as i64))
  } else {
    Number::from_f64(value)
  }
}

fn as_f64(value: &Any) -> Option<f64> {
  match value {
    Any::Integer(value) => Some(f64::from(*value)),
    Any::Float32(value) => Some(f64::from(value.0)),
    Any::Float64(value) => Some(value.0),
    _ => None,
  }
}

fn any_prop(block: &Map, key: &str) -> Option<Any> {
  match block.get(key)? {
    Value::Any(any) => Some(any),
    _ => None,
  }
}

/// A string prop, or the plain text of a `Y.Text` prop.
fn string_prop(block: &Map, key: &str) -> Option<String> {
  block.get(key).and_then(|value| value_to_string(&value))
}

fn value_to_string(value: &Value) -> Option<String> {
  match value {
    Value::Any(Any::String(value)) => Some(value.clone()),
    Value::Text(text) => Some(text.to_string()),
    _ => None,
  }
}
