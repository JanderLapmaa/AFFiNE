// Builds the shared Tasks fixture with plain Yjs. Regenerate with:
//   node --experimental-strip-types packages/common/reader/__tests__/tasks-fixture.ts
// Writes packages/common/native/fixtures/tasks.ydoc and tasks.ydoc.expected.json.
// Both the JS reader spec and the native nbstore indexer tests assert against them.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  Array as YArray,
  ContentAny,
  createID,
  Doc as YDoc,
  encodeStateAsUpdate,
  getState,
  Item,
  Map as YMap,
  Text as YText,
} from 'yjs';

type Props = Record<string, unknown>;
interface Node {
  id: string;
  flavour: string;
  props?: Props;
  text?: string;
  children?: Node[];
}

const n = (
  id: string,
  flavour: string,
  props: Props = {},
  text?: string,
  children: Node[] = []
): Node => ({ id, flavour, props, text, children });
const h = (id: string, type: string, text: string, children: Node[] = []) =>
  n(id, 'affine:paragraph', { type }, text, children);
const todo = (id: string, text: string, props: Props = {}) =>
  n(id, 'affine:list', { type: 'todo', ...props }, text);

const tree: Node = n('page', 'affine:page', {}, 'Tasks fixture', [
  n('surface', 'affine:surface'),
  n('note-1', 'affine:note', { displayMode: 'both' }, undefined, [
    todo('t-before-heading', 'before any heading'),
    h('h1-a', 'h1', 'Alpha', [
      todo('t-under-h1-checked', 'checked', {
        checked: true,
        completedAt: 1767225600000,
      }),
    ]),
    todo('t-due-priority', 'due and priority', {
      due: '2026-01-05',
      priority: 3,
    }),
    todo('t-priority-zero', 'priority zero', { priority: 0 }),
    todo('t-bad-due', 'bad due', { due: '2026-1-5' }),
    todo('t-bad-priority', 'bad priority', { priority: 2.5 }),
    todo('t-out-of-range', 'out of range priority', { priority: 4 }),
    todo('t-stale-completed', 'stale completedAt', {
      checked: false,
      completedAt: 1767225600000,
    }),
    n('bullet', 'affine:list', { type: 'bulleted', checked: true }, 'bullet'),
    h('h2-b', 'h2', '  Beta  '),
    todo('t-under-h2', 'under h2'),
    n('outer', 'affine:list', { type: 'bulleted' }, 'outer', [
      todo('t-nested', 'nested todo', { due: '2026-02-01' }),
    ]),
    h('h-blank', 'h3', '   '),
    todo('t-under-blank-heading', 'under blank heading'),
  ]),
  n('note-2', 'affine:note', { displayMode: 'both' }, undefined, [
    todo('t-second-note', 'second note'),
    todo('t-bigint', 'bigint props', {
      priority: 3n,
      completedAt: 1767225600000n,
    }),
  ]),
]);

// blockId -> exact contract fields, written by hand (not derived from the reader)
export const expectedTaskFields: Record<string, Record<string, unknown>> = {
  't-before-heading': { listType: 'todo', checked: false, order: 3 },
  't-under-h1-checked': {
    listType: 'todo',
    checked: true,
    completedAt: 1767225600000,
    heading: 'Alpha',
    order: 5,
  },
  't-due-priority': {
    listType: 'todo',
    checked: false,
    due: '2026-01-05',
    priority: 3,
    heading: 'Alpha',
    order: 6,
  },
  't-priority-zero': {
    listType: 'todo',
    checked: false,
    heading: 'Alpha',
    order: 7,
  },
  't-bad-due': { listType: 'todo', checked: false, heading: 'Alpha', order: 8 },
  't-bad-priority': {
    listType: 'todo',
    checked: false,
    heading: 'Alpha',
    order: 9,
  },
  't-out-of-range': {
    listType: 'todo',
    checked: false,
    heading: 'Alpha',
    order: 10,
  },
  't-stale-completed': {
    listType: 'todo',
    checked: false,
    completedAt: 1767225600000,
    heading: 'Alpha',
    order: 11,
  },
  't-under-h2': {
    listType: 'todo',
    checked: false,
    heading: 'Beta',
    order: 14,
  },
  't-nested': {
    listType: 'todo',
    checked: false,
    due: '2026-02-01',
    heading: 'Beta',
    order: 16,
  },
  't-under-blank-heading': { listType: 'todo', checked: false, order: 18 },
  't-second-note': { listType: 'todo', checked: false, order: 20 },
  't-bigint': { listType: 'todo', checked: false, order: 21 },
};

// Y.Map#set rejects bigint, so integrate the item by hand (what a client
// writing a bigint through the lower-level API would produce).
function setBigInt(doc: YDoc, map: YMap<unknown>, key: string, value: bigint) {
  const id = createID(doc.clientID, getState(doc.store, doc.clientID));
  const left = map._map.get(key) ?? null;
  const item = new Item(
    id,
    left,
    left && left.lastId,
    null,
    null,
    map,
    key,
    new ContentAny([value])
  );
  item.integrate(doc._transaction!, 0);
}

export function buildTasksDoc(): YDoc {
  const doc = new YDoc({ guid: 'tasks-fixture' });
  doc.clientID = 1;
  const blocks = doc.getMap<YMap<unknown>>('blocks');
  doc.transact(() => {
    const add = (node: Node) => {
      const block = new YMap<unknown>();
      blocks.set(node.id, block);
      block.set('sys:id', node.id);
      block.set('sys:flavour', node.flavour);
      const children = new YArray<string>();
      block.set('sys:children', children);
      for (const [k, v] of Object.entries(node.props ?? {})) {
        if (typeof v === 'bigint') setBigInt(doc, block, `prop:${k}`, v);
        else block.set(`prop:${k}`, v);
      }
      if (node.text !== undefined) {
        const key = node.flavour === 'affine:page' ? 'prop:title' : 'prop:text';
        block.set(key, new YText(node.text));
      }
      children.push((node.children ?? []).map(c => c.id));
      node.children?.forEach(add);
    };
    add(tree);
  });
  return doc;
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const dir = path.join(import.meta.dirname, '../../native/fixtures');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'tasks.ydoc'),
    encodeStateAsUpdate(buildTasksDoc())
  );
  writeFileSync(
    path.join(dir, 'tasks.ydoc.expected.json'),
    JSON.stringify(expectedTaskFields, null, 2) + '\n'
  );
}
