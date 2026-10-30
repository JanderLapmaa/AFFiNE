import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  encodeStateVector,
  type Map as YMap,
} from 'yjs';

export type TaskCheckedDelta =
  /** the block does not exist or is not a todo list block */
  | { kind: 'not-a-task' }
  /** the block is already in the requested state */
  | { kind: 'unchanged' }
  | { kind: 'delta'; update: Uint8Array };

/**
 * The minimal Yjs update that sets a todo's `checked` and keeps `completedAt`
 * in step, the same way the editor's `setTodoChecked` does: ticking writes
 * `completedAt = now`, unticking deletes it.
 */
export function buildTaskCheckedDelta(
  docBin: Uint8Array,
  blockId: string,
  checked: boolean,
  now: number
): TaskCheckedDelta {
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

  const completedAt = block.get('prop:completedAt');
  const alreadyChecked = block.get('prop:checked') === true;
  if (
    alreadyChecked === checked &&
    (checked ? typeof completedAt === 'number' : completedAt === undefined)
  ) {
    return { kind: 'unchanged' };
  }

  const before = encodeStateVector(doc);
  doc.transact(() => {
    if (alreadyChecked !== checked) block.set('prop:checked', checked);
    if (checked) {
      if (typeof completedAt !== 'number') block.set('prop:completedAt', now);
    } else if (completedAt !== undefined) {
      block.delete('prop:completedAt');
    }
  });
  return { kind: 'delta', update: encodeStateAsUpdate(doc, before) };
}
