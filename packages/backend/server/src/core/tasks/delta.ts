import {
  applyUpdate,
  Array as YArray,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  Map as YMap,
  Text as YText,
} from 'yjs';

import { BadRequest } from '../../base';

/** Fields of a task a client may change. Omitted means no change. */
export interface TaskChanges {
  checked?: boolean;
  /** YYYY-MM-DD, null clears it */
  due?: string | null;
  /** 1-3, null or 0 clears it */
  priority?: number | null;
}

export type TaskDelta =
  /** the block does not exist or is not a todo list block */
  | { kind: 'not-a-task' }
  /** the block already has the requested values */
  | { kind: 'unchanged' }
  | { kind: 'delta'; update: Uint8Array };

const DUE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function validateTaskChanges(changes: TaskChanges) {
  const { due, priority } = changes;
  if (typeof due === 'string') {
    const valid =
      DUE_PATTERN.test(due) &&
      !Number.isNaN(Date.parse(`${due}T00:00:00Z`)) &&
      new Date(`${due}T00:00:00Z`).toISOString().startsWith(due);
    if (!valid) throw new BadRequest('due must be a date as YYYY-MM-DD.');
  }
  if (
    typeof priority === 'number' &&
    !(Number.isInteger(priority) && priority >= 0 && priority <= 3)
  ) {
    throw new BadRequest('priority must be 0 to 3.');
  }
}

/**
 * The minimal Yjs update that applies `changes` to a todo, the way the client
 * writes them: ticking sets `completedAt = now` and unticking deletes it (like
 * the editor's `setTodoChecked`); a cleared due or priority deletes the prop.
 * Values are expected to pass `validateTaskChanges`.
 */
export function buildTaskDelta(
  docBin: Uint8Array,
  blockId: string,
  changes: TaskChanges,
  now: number
): TaskDelta {
  const doc = new Doc();
  applyUpdate(doc, docBin);

  const block = doc.getMap<YMap<unknown>>('blocks').get(blockId);
  if (
    !block ||
    block.get('sys:flavour')?.toString() !== 'affine:list' ||
    block.get('prop:type') !== 'todo'
  ) {
    return { kind: 'not-a-task' };
  }

  const ops: (() => void)[] = [];
  const setOrClear = (prop: string, value: unknown) => {
    const key = `prop:${prop}`;
    if (value === null) {
      if (block.has(key)) ops.push(() => block.delete(key));
    } else if (block.get(key) !== value) {
      ops.push(() => block.set(key, value));
    }
  };

  if (changes.checked !== undefined) {
    const checked = changes.checked;
    const completedAt = block.get('prop:completedAt');
    if ((block.get('prop:checked') === true) !== checked) {
      ops.push(() => block.set('prop:checked', checked));
    }
    if (checked) {
      if (typeof completedAt !== 'number') {
        ops.push(() => block.set('prop:completedAt', now));
      }
    } else if (completedAt !== undefined) {
      ops.push(() => block.delete('prop:completedAt'));
    }
  }
  if (changes.due !== undefined) setOrClear('due', changes.due);
  if (changes.priority !== undefined) {
    setOrClear('priority', changes.priority || null);
  }

  if (!ops.length) return { kind: 'unchanged' };
  const before = encodeStateVector(doc);
  doc.transact(() => ops.forEach(op => op()));
  return { kind: 'delta', update: encodeStateAsUpdate(doc, before) };
}

/** A todo to add (quick add). */
export interface NewTask {
  text: string;
  /** YYYY-MM-DD */
  due?: string | null;
  /** 1-3; null or 0 for none */
  priority?: number | null;
}

/** Longest text a quick-added task may have. */
export const MAX_TASK_TEXT = 10_000;

/** Trims the text and checks the fields; returns the task to write. */
export function validateNewTask(task: NewTask): NewTask {
  const text = task.text.trim();
  if (!text) throw new BadRequest('text must not be empty.');
  if (text.length > MAX_TASK_TEXT) {
    throw new BadRequest(`text must be at most ${MAX_TASK_TEXT} characters.`);
  }
  validateTaskChanges({ due: task.due, priority: task.priority });
  return { ...task, text };
}

/**
 * The Yjs update that appends an unchecked todo block `blockId` to the first
 * note of the doc, with the props a client's `addBlock` would give it. Returns
 * null when the doc has no note to add it to.
 */
export function buildAppendTodoDelta(
  docBin: Uint8Array,
  blockId: string,
  task: NewTask
): Uint8Array | null {
  const doc = new Doc();
  applyUpdate(doc, docBin);
  const blocks = doc.getMap<YMap<unknown>>('blocks');
  const flavourOf = (block: YMap<unknown> | undefined) =>
    block?.get('sys:flavour')?.toString();
  const childrenOf = (block: YMap<unknown> | undefined) => {
    const children = block?.get('sys:children');
    return children instanceof YArray ? (children as YArray<string>) : null;
  };

  // The first note under the page, in page order.
  const page = [...blocks.values()].find(b => flavourOf(b) === 'affine:page');
  const noteId = childrenOf(page)
    ?.toArray()
    .find(id => flavourOf(blocks.get(id)) === 'affine:note');
  const children = noteId ? childrenOf(blocks.get(noteId)) : null;
  if (!children) return null;

  const before = encodeStateVector(doc);
  doc.transact(() => {
    const block = new YMap<unknown>();
    block.set('sys:id', blockId);
    block.set('sys:flavour', 'affine:list');
    block.set('sys:version', 1);
    block.set('sys:children', new YArray<string>());
    block.set('prop:type', 'todo');
    block.set('prop:text', new YText(task.text));
    block.set('prop:checked', false);
    block.set('prop:collapsed', false);
    block.set('prop:order', null);
    if (task.due) block.set('prop:due', task.due);
    if (task.priority) block.set('prop:priority', task.priority);
    blocks.set(blockId, block);
    children.push([blockId]);
  });
  return encodeStateAsUpdate(doc, before);
}
