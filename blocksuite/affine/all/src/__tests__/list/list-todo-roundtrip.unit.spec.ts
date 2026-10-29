/**
 * Guards the storage decision for the Tasks view: `due`, `priority` and
 * `completedAt` live as optional props on `affine:list`. They survive an
 * unmodified (old-schema) client, AFFiNE snapshot export/import and
 * copy/paste; text formats drop them by design.
 */
import {
  type ListBlockModel,
  ListBlockSchemaExtension,
  NoteBlockSchemaExtension,
  RootBlockSchemaExtension,
} from '@blocksuite/affine-model';
import {
  HtmlAdapter,
  MarkdownAdapter,
  PlainTextAdapter,
} from '@blocksuite/affine-shared/adapters';
import {
  AssetsManager,
  BlockModel,
  BlockSchemaExtension,
  type BlockSnapshot,
  defineBlockSchema,
  type DocSnapshot,
  MemoryBlobCRUD,
  Schema,
  Slice,
  type Store,
  Text,
  Transformer,
} from '@blocksuite/store';
import {
  createAutoIncrementIdGenerator,
  TestWorkspace,
} from '@blocksuite/store/test';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import { AffineSchemas } from '../../schemas.js';
import { createJob } from '../utils/create-job.js';
import { getProvider } from '../utils/get-provider.js';

// Canary `affine:list` without the task props: an unmodified client.
const OldListBlockSchema = defineBlockSchema({
  flavour: 'affine:list',
  props: internal => ({
    type: 'bulleted',
    text: internal.Text(),
    checked: false,
    collapsed: false,
    order: null,
  }),
  metadata: {
    version: 1,
    role: 'content',
    parent: ['affine:note', 'affine:list'],
  },
  toModel: () => new (class extends BlockModel {})() as never,
});
const oldExtensions = [
  RootBlockSchemaExtension,
  NoteBlockSchemaExtension,
  BlockSchemaExtension(OldListBlockSchema),
];
const newExtensions = [
  RootBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ListBlockSchemaExtension,
];

const TASK_KEYS = ['due', 'priority', 'completedAt'] as const;
const A = { due: '2026-11-02', priority: 3, completedAt: 1700000000000 };

function openStore(old: boolean, id = 'doc0') {
  const collection = new TestWorkspace({
    id: 'test-collection',
    idGenerator: createAutoIncrementIdGenerator(),
  });
  collection.meta.initialize();
  const store = collection
    .createDoc(id)
    .getStore({ extensions: old ? oldExtensions : newExtensions });
  store.doc.load();
  return { collection, store };
}

/** New-schema doc: a (checked, all props), b (open, due+priority). */
function seed() {
  const { store } = openStore(false);
  const root = store.addBlock('affine:page');
  const note = store.addBlock('affine:note', {}, root);
  const list = (text: string, props: object) =>
    store.addBlock(
      'affine:list',
      { type: 'todo', text: new Text(text), ...props },
      note
    );
  const a = list('task a', { checked: true, ...A });
  const b = list('task b', { due: '2026-11-05', priority: 1 });
  return { store, a, b, note };
}

const modelOf = (store: Store, id: string) =>
  store.getBlock(id)!.model as ListBlockModel;
const propsOf = (store: Store, id: string) => {
  const p = modelOf(store, id).props as Record<string, unknown>;
  return { due: p.due, priority: p.priority, completedAt: p.completedAt };
};
const textOf = (store: Store, id: string) =>
  modelOf(store, id).props.text.toString();
const findByText = (store: Store, text: string) =>
  store
    .getModelsByFlavour('affine:list')
    .find(m => (m as ListBlockModel).props.text.toString() === text)!;

function sync(from: Store, to: Store) {
  Y.applyUpdate(
    to.doc.spaceDoc,
    Y.encodeStateAsUpdate(
      from.doc.spaceDoc,
      Y.encodeStateVector(to.doc.spaceDoc)
    )
  );
}

function findLists(snapshot: BlockSnapshot): BlockSnapshot[] {
  return [
    ...(snapshot.flavour === 'affine:list' ? [snapshot] : []),
    ...snapshot.children.flatMap(findLists),
  ];
}

describe('unmodified client', () => {
  function loadOnOldClient() {
    const seeded = seed();
    const { store: oldStore } = openStore(true);
    sync(seeded.store, oldStore);
    return { ...seeded, oldStore };
  }

  test('edits by an old client keep the props and merge back', () => {
    const { store, oldStore, a, b, note } = loadOnOldClient();
    const oldA = oldStore.getBlock(a)!.model as unknown as ListBlockModel;
    const oldB = oldStore.getBlock(b)!.model as unknown as ListBlockModel;

    oldA.props.text.insert(' edited', oldA.props.text.length);
    oldStore.updateBlock(oldB, { checked: true });
    oldStore.updateBlock(oldA, { type: 'bulleted' });
    oldStore.updateBlock(oldA, { type: 'todo' });
    oldStore.moveBlocks([oldB], oldA);
    oldStore.moveBlocks([oldB], oldStore.getBlock(note)!.model);

    expect(propsOf(oldStore, a)).toEqual(A);
    sync(oldStore, store);
    expect(textOf(store, a)).toBe('task a edited');
    expect(propsOf(store, a)).toEqual(A);
    expect(propsOf(store, b)).toMatchObject({ due: '2026-11-05', priority: 1 });
    expect(modelOf(store, b).props.checked).toBe(true);
  });

  test('unchecking leaves a stale completedAt, so checked wins', () => {
    const { store, oldStore, a } = loadOnOldClient();
    oldStore.updateBlock(oldStore.getBlock(a)!.model, { checked: false });
    sync(oldStore, store);
    // consumers must ignore completedAt when checked is false
    expect(modelOf(store, a).props.checked).toBe(false);
    expect(modelOf(store, a).props.completedAt).toBe(A.completedAt);
  });
});

describe('AFFiNE-format export/import and copy/paste', () => {
  test('snapshot -> JSON -> snapshotToDoc keeps the props', async () => {
    const { store } = seed();
    const { collection } = openStore(false, 'target');
    collection.storeExtensions = newExtensions;
    const job = new Transformer({
      schema: new Schema().register(AffineSchemas),
      blobCRUD: collection.blobSync,
      docCRUD: {
        create: id => collection.createDoc(id).getStore({ id }),
        get: id => collection.getDoc(id)?.getStore({ id }) ?? null,
        delete: id => collection.removeDoc(id),
      },
    });
    const snapshot = JSON.parse(
      JSON.stringify(job.docToSnapshot(store)!)
    ) as DocSnapshot;
    snapshot.meta.id = 'imported';
    const imported = (await job.snapshotToDoc(snapshot))!;
    expect(propsOf(imported, findByText(imported, 'task a').id)).toEqual(A);
  });

  test('clipboard slice pasted into another doc keeps the props', async () => {
    const { store, a } = seed();
    const job = createJob();
    const snapshot = job.sliceToSnapshot(
      Slice.fromModels(store, [modelOf(store, a)])
    )!;
    const parsed = JSON.parse(JSON.stringify(snapshot));

    const target = openStore(false, 'doc1').store;
    const note = target.addBlock(
      'affine:note',
      {},
      target.addBlock('affine:page')
    );
    await job.snapshotToSlice(parsed, target, note, 0);
    expect(propsOf(target, findByText(target, 'task a').id)).toEqual(A);
  });
});

describe('text formats drop the props', () => {
  const provider = getProvider();
  const assets = () => new AssetsManager({ blob: new MemoryBlobCRUD() });

  test.each([
    ['markdown', MarkdownAdapter],
    ['html', HtmlAdapter],
    ['plain text', PlainTextAdapter],
  ] as const)('%s', async (_name, Adapter) => {
    const job = createJob();
    const snapshot = job.docToSnapshot(seed().store)!;
    const adapter = new Adapter(job, provider);
    const out = await adapter.fromDocSnapshot({ snapshot, assets: assets() });
    expect(out.file).not.toContain('2026-11-02');
    expect(out.file).not.toContain('1700000000000');

    const back = await adapter.toDocSnapshot({
      file: out.file,
      assets: assets(),
    });
    for (const list of findLists(back.blocks)) {
      for (const key of TASK_KEYS) expect(list.props[key]).toBeUndefined();
    }
  });
});
