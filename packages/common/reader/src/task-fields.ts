/**
 * Task (todo list block) extraction shared by the JS reader, the electron/web
 * indexer and the server task list. It depends on `yjs` only, so the server can
 * import it (`@affine/reader/task-fields`) without pulling in blocksuite.
 * The Rust twin is `packages/frontend/native/nbstore/src/indexer/task_fields.rs`
 * and must keep the same semantics.
 */
import {
  Array as YArray,
  type Doc as YDoc,
  type Map as YMap,
  Text as YText,
} from 'yjs';

/** Task fields as indexed in `additional` of a todo list block. */
export interface TaskFields {
  listType: 'todo';
  checked: boolean;
  due?: string;
  priority?: 1 | 2 | 3;
  completedAt?: number;
  heading?: string;
  order?: number;
  // [UTF-16 offset in `content`, doc id] per linked-doc reference
  refs?: [number, string][];
}

/** One row of the server task list. */
export interface TaskRow {
  blockId: string;
  text: string;
  refs: [number, string][];
  checked: boolean;
  /** YYYY-MM-DD */
  due: string | null;
  priority: 1 | 2 | 3 | null;
  /** whole epoch ms; null when unchecked (a stale value on an unchecked task is dropped) */
  completedAt: number | null;
  heading: string | null;
  order: number;
}

const DUE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HEADING_TYPES = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * Pre-order walk from the page block over `sys:children`; maps each todo list
 * block id to the trimmed text of the last heading visited before it (may be
 * empty) and its 0-based position among all blocks visited in the walk. Kept
 * independent of the reader's own traversal order.
 */
export function collectTodoHeadings(
  blocks: YMap<YMap<any>>
): Map<string, { heading: string; order: number }> {
  const result = new Map<string, { heading: string; order: number }>();
  // several pages: the walk starts from the lowest sys:id (string order),
  // independent of the page the reader itself treats as root
  let pageId: string | null = null;
  for (const block of blocks.values()) {
    const id = block.get('sys:id')?.toString();
    if (
      block.get('sys:flavour')?.toString() === 'affine:page' &&
      id &&
      (pageId === null || id < pageId)
    ) {
      pageId = id;
    }
  }
  const visited = new Set<string>();
  const stack = pageId ? [pageId] : [];
  let heading = '';
  let position = 0;
  while (stack.length) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const block = blocks.get(id);
    if (!block) continue;
    const order = position++;
    const flavour = block.get('sys:flavour')?.toString();
    if (
      flavour === 'affine:paragraph' &&
      HEADING_TYPES.has(block.get('prop:type'))
    ) {
      heading = (block.get('prop:text')?.toString() ?? '').trim();
    } else if (flavour === 'affine:list' && block.get('prop:type') === 'todo') {
      result.set(id, { heading, order });
    }
    const children = block.get('sys:children');
    if (children instanceof YArray) {
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children.get(i));
      }
    }
  }
  return result;
}

/**
 * Linked-doc references in a todo's text as `[offset, docId]`, with the UTF-16
 * offset of the reference's placeholder in the text. Embeds are not part of
 * `Y.Text#toString()` (the indexed `content`), so they count as 0 units.
 */
/** The doc a rich-text delta links to, if it is a doc reference. */
export const referencedDocId = (delta: {
  attributes?: { reference?: { pageId?: string } | null };
}) => delta.attributes?.reference?.pageId;

export function readTaskRefs(text: unknown): [number, string][] {
  if (!(text instanceof YText)) return [];
  const refs: [number, string][] = [];
  let offset = 0;
  for (const delta of text.toDelta() as {
    insert?: unknown;
    attributes?: { reference?: { pageId?: string } | null };
  }[]) {
    const pageId = referencedDocId(delta);
    if (pageId) refs.push([offset, pageId]);
    if (typeof delta.insert === 'string') offset += delta.insert.length;
  }
  return refs;
}

export function readTaskFields(
  block: YMap<any>,
  walk: { heading: string; order: number } | undefined
): TaskFields {
  const due = block.get('prop:due');
  const priority = block.get('prop:priority');
  const completedAt = block.get('prop:completedAt');
  const refs = readTaskRefs(block.get('prop:text'));
  return {
    listType: 'todo',
    checked: block.get('prop:checked') === true,
    ...(typeof due === 'string' && DUE_PATTERN.test(due) ? { due } : {}),
    ...(priority === 1 || priority === 2 || priority === 3 ? { priority } : {}),
    ...(typeof completedAt === 'number' && Number.isFinite(completedAt)
      ? { completedAt }
      : {}),
    ...(walk?.heading ? { heading: walk.heading } : {}),
    ...(walk ? { order: walk.order } : {}),
    ...(refs.length ? { refs } : {}),
  };
}

/**
 * The todo list blocks of a doc with the same `content` and task fields
 * `readAllBlocksFromDoc` indexes, without the rest of the crawl. For reading
 * an open doc's tasks live.
 */
export function readTodoBlocks(ydoc: YDoc): {
  blockId: string;
  content: string;
  additional: TaskFields;
}[] {
  const blocks = ydoc.getMap<any>('blocks');
  const result = [];
  for (const [blockId, walk] of collectTodoHeadings(blocks)) {
    const block = blocks.get(blockId);
    const text = block?.get('prop:text');
    if (!block || !(text instanceof YText)) continue;
    result.push({
      blockId,
      content: text.toString(),
      additional: readTaskFields(block, walk),
    });
  }
  return result;
}

/** Whole milliseconds, or null when absent or not a safe integer. */
function toEpochMs(value: number | undefined) {
  if (value === undefined) return null;
  const ms = Math.trunc(value);
  return Number.isSafeInteger(ms) ? ms : null;
}

/**
 * The tasks of a doc, in document order, as stored by the server task list.
 * Applies the projection's rules: a todo with blank text and no doc reference
 * is not a task, and `completedAt` is only kept on a checked task.
 * Trashed docs and templates are not known here; clients filter those.
 */
export function readDocTasks(ydoc: YDoc): TaskRow[] {
  const rows: TaskRow[] = [];
  for (const { blockId, content, additional } of readTodoBlocks(ydoc)) {
    const refs = additional.refs ?? [];
    if (!content.trim() && !refs.length) continue;
    rows.push({
      blockId,
      text: content,
      refs,
      checked: additional.checked,
      due: additional.due ?? null,
      priority: additional.priority ?? null,
      completedAt: additional.checked
        ? toEpochMs(additional.completedAt)
        : null,
      heading: additional.heading ?? null,
      order: additional.order ?? 0,
    });
  }
  rows.sort((a, b) => a.order - b.order);
  return rows;
}
