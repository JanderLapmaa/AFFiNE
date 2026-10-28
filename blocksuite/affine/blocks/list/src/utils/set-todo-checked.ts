import {
  getTodoCheckedProps,
  type ListBlockModel,
} from '@blocksuite/affine-model';
import type { Store } from '@blocksuite/store';

/**
 * Check or uncheck a todo, keeping `completedAt` in step with `checked`.
 * Interactive writers of an existing todo's `checked` should go through this.
 * The import adapters (markdown, html, notion-html) are the exception: they
 * deliberately leave `completedAt` unset for checked todos, because the real
 * completion time of imported content is unknown.
 */
export function setTodoChecked(
  store: Store,
  model: ListBlockModel,
  checked: boolean,
  now: number = Date.now()
) {
  if (store.readonly) return;
  store.transact(() => {
    store.updateBlock(model, getTodoCheckedProps(checked, now));
    if (!checked) delete model.props.completedAt;
  });
}
