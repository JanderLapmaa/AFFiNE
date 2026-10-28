import type { Text } from '@blocksuite/store';
import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
} from '@blocksuite/store';

import type { TextAlign } from '../../consts';
import type { BlockMeta } from '../../utils/types';

// `toggle` type has been deprecated, do not use it
export type ListType = 'bulleted' | 'numbered' | 'todo' | 'toggle';

// 0/undefined none, 1 low, 2 medium, 3 high
export type ListPriority = 0 | 1 | 2 | 3;

export type ListProps = {
  type: ListType;
  text: Text;
  textAlign?: TextAlign;
  checked: boolean;
  collapsed: boolean;
  order: number | null;
  comments?: Record<string, boolean>;
  // ISO date 'YYYY-MM-DD', local calendar day, no time
  due?: string;
  priority?: ListPriority;
  // epoch ms; set when checked, cleared when unchecked
  completedAt?: number;
} & BlockMeta;

export const ListBlockSchema = defineBlockSchema({
  flavour: 'affine:list',
  props: internal =>
    ({
      type: 'bulleted',
      text: internal.Text(),
      textAlign: undefined,
      checked: false,
      collapsed: false,

      // number type only for numbered list
      order: null,
      comments: undefined,
      due: undefined,
      priority: undefined,
      completedAt: undefined,
      'meta:createdAt': undefined,
      'meta:createdBy': undefined,
      'meta:updatedAt': undefined,
      'meta:updatedBy': undefined,
    }) as ListProps,
  metadata: {
    version: 1,
    role: 'content',
    parent: [
      'affine:note',
      'affine:database',
      'affine:list',
      'affine:paragraph',
      'affine:edgeless-text',
      'affine:callout',
    ],
  },
  toModel: () => new ListBlockModel(),
});

export const ListBlockSchemaExtension = BlockSchemaExtension(ListBlockSchema);

export class ListBlockModel extends BlockModel<ListProps> {}

/**
 * Props for a todo created with a given `checked` state (`addBlock`).
 * For an existing block use `setTodoChecked` (in the list block package):
 * `updateBlock` ignores `undefined` values, so it cannot clear `completedAt`.
 */
export function getTodoCheckedProps(
  checked: boolean,
  now: number = Date.now()
): Pick<ListProps, 'checked' | 'completedAt'> {
  return { checked, completedAt: checked ? now : undefined };
}
