import { setTodoChecked } from '@blocksuite/affine/blocks/list';
import type { ListBlockModel } from '@blocksuite/affine/model';
import type { Store } from '@blocksuite/affine/store';

import type { TaskPriority } from '../types';
import type { Patch, TaskValues } from './types';

export function splitTaskId(id: string) {
  const at = id.indexOf(':');
  if (at <= 0 || at === id.length - 1) {
    throw new Error(`Invalid task id: ${id}`);
  }
  return { docId: id.slice(0, at), blockId: id.slice(at + 1) };
}

function writeProp(
  store: Store,
  model: ListBlockModel,
  key: 'due' | 'priority',
  value: string | number | null
) {
  if (value === null) {
    store.transact(() => {
      delete model.props[key];
    });
  } else {
    store.updateBlock(model, { [key]: value } as Partial<
      ListBlockModel['props']
    >);
  }
}

/**
 * Writes `decide(the block's current values)` into the list block of a loaded
 * doc and returns the previous values of what changed.
 */
export function writeTaskValues(
  store: Store,
  ref: { docId: string; blockId: string },
  decide: (before: TaskValues) => Patch,
  now: () => number
): Patch {
  if (store.readonly) {
    throw new Error(`Doc ${ref.docId} is read-only`);
  }
  const model = store.getBlock(ref.blockId)?.model as
    | ListBlockModel
    | undefined;
  if (!model || model.flavour !== 'affine:list') {
    throw new Error(`Task block not found: ${ref.docId}:${ref.blockId}`);
  }
  const before: TaskValues = {
    due: model.props.due ?? null,
    priority: (model.props.priority ?? 0) as TaskPriority,
    checked: model.props.checked === true,
    completedAt: model.props.completedAt ?? null,
  };
  const changes = decide(before);
  if (changes.due !== undefined) {
    writeProp(store, model, 'due', changes.due);
  }
  if (changes.priority !== undefined) {
    writeProp(store, model, 'priority', changes.priority || null);
  }
  if (changes.checked !== undefined) {
    const at = changes.completedAt ?? now();
    setTodoChecked(store, model, changes.checked, at);
  }
  // Only what this write changed is written back.
  const previous: Patch = {};
  for (const key of Object.keys(changes) as (keyof TaskValues)[]) {
    Object.assign(previous, { [key]: before[key] });
  }
  return previous;
}
