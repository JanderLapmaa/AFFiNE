/**
 * Guards the storage decision for the Tasks view: `due`, `priority` and
 * `completedAt` live as optional props on `affine:list`.
 *
 * The props survive (A) an unmodified client, (B) the snapshot (zip)
 * transformer, i.e. AFFiNE-format export/import, and (C) clipboard copy/paste
 * (slash-menu duplicate is covered elsewhere). Text formats (D: markdown,
 * html, plain text) drop them by design.
 *
 * Schema version: checked and left at 1. The store has no migrations, and
 * earlier additive props (textAlign, comments) did not bump it either.
 */
import { ZipTransformer } from '@blocksuite/affine/widgets/linked-doc';
import { setTodoChecked } from '@blocksuite/affine-block-list';
import {
  type ListBlockModel,
  ListBlockSchemaExtension,
  NoteBlockSchema,
  NoteBlockSchemaExtension,
  RootBlockSchema,
  RootBlockSchemaExtension,
} from '@blocksuite/affine-model';
import {
  HtmlAdapter,
  MarkdownAdapter,
  NotionHtmlAdapter,
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
import * as fflate from 'fflate';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';

import { AffineSchemas } from '../../schemas.js';
import { createJob } from '../utils/create-job.js';
import { getProvider } from '../utils/get-provider.js';

// ---------------------------------------------------------------------------
// Old client: verbatim copy of the canary `affine:list` schema (no task props).
// Same flavour, so it stands in for an unmodified client reading the same doc.
// ---------------------------------------------------------------------------
class OldListBlockModel extends BlockModel<Record<string, unknown>> {}

const OldListBlockSchema = defineBlockSchema({
  flavour: 'affine:list',
  props: internal =>
    ({
      type: 'bulleted',
      text: internal.Text(),
      textAlign: undefined,
      checked: false,
      collapsed: false,
      order: null,
      comments: undefined,
      'meta:createdAt': undefined,
      'meta:createdBy': undefined,
      'meta:updatedAt': undefined,
      'meta:updatedBy': undefined,
    }) as Record<string, unknown>,
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
  toModel: () => new OldListBlockModel(),
});
const OldListBlockSchemaExtension = BlockSchemaExtension(OldListBlockSchema);

const newExtensions = [
  RootBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ListBlockSchemaExtension,
];
const oldExtensions = [
  RootBlockSchemaExtension,
  NoteBlockSchemaExtension,
  OldListBlockSchemaExtension,
];
const oldSchema = new Schema().register([
  RootBlockSchema,
  NoteBlockSchema,
  OldListBlockSchema,
]);
const newSchema = new Schema().register(AffineSchemas);

type Kind = 'new' | 'old';

const TASK_KEYS = ['due', 'priority', 'completedAt'] as const;

function createWorkspace(kind: Kind) {
  const collection = new TestWorkspace({
    id: 'test-collection',
    idGenerator: createAutoIncrementIdGenerator(),
  });
  collection.meta.initialize();
  if (kind === 'new') {
    collection.storeExtensions = [];
  }
  return collection;
}

function openStore(kind: Kind, collection: TestWorkspace, id = 'doc0') {
  const doc = collection.createDoc(id);
  const store = doc.getStore({
    extensions: kind === 'new' ? newExtensions : oldExtensions,
  });
  doc.load();
  return { doc, store };
}

type Ids = { root: string; note: string; a: string; b: string; sib: string };

/** New-schema doc: a (checked, all props), b (open, due+priority), sibling. */
function seedNewDoc() {
  const collection = createWorkspace('new');
  const { doc, store } = openStore('new', collection);
  const root = store.addBlock('affine:page');
  const note = store.addBlock('affine:note', {}, root);
  const a = store.addBlock(
    'affine:list',
    {
      type: 'todo',
      text: new Text('task a'),
      checked: true,
      due: '2026-11-02',
      priority: 3,
      completedAt: 1700000000000,
    },
    note
  );
  const b = store.addBlock(
    'affine:list',
    {
      type: 'todo',
      text: new Text('task b'),
      due: '2026-11-05',
      priority: 1,
    },
    note
  );
  const sib = store.addBlock(
    'affine:list',
    { type: 'bulleted', text: new Text('sibling') },
    note
  );
  const ids: Ids = { root, note, a, b, sib };
  return { collection, doc, store, ids };
}

function modelOf(store: Store, id: string) {
  return store.getBlock(id)!.model as ListBlockModel;
}

function yProps(store: Store, id: string) {
  const yBlock = store.doc.yBlocks.get(id)!;
  return {
    due: yBlock.get('prop:due'),
    priority: yBlock.get('prop:priority'),
    completedAt: yBlock.get('prop:completedAt'),
    has: TASK_KEYS.map(k => yBlock.has(`prop:${k}`)),
  };
}

function modelProps(store: Store, id: string) {
  const props = modelOf(store, id).props as Record<string, unknown>;
  return {
    due: props.due,
    priority: props.priority,
    completedAt: props.completedAt,
  };
}

function sync(from: Store, to: Store) {
  const update = Y.encodeStateAsUpdate(
    from.doc.spaceDoc,
    Y.encodeStateVector(to.doc.spaceDoc)
  );
  Y.applyUpdate(to.doc.spaceDoc, update);
}

function findLists(snapshot: BlockSnapshot): BlockSnapshot[] {
  const out: BlockSnapshot[] = [];
  const visit = (b: BlockSnapshot) => {
    if (b.flavour === 'affine:list') out.push(b);
    b.children.forEach(visit);
  };
  visit(snapshot);
  return out;
}

function listByText(lists: BlockSnapshot[], text: string) {
  return lists.find(l => {
    const delta = (l.props.text as { delta?: { insert: string }[] })?.delta;
    return delta?.map(d => d.insert).join('') === text;
  });
}

function textOf(store: Store, id: string) {
  return modelOf(store, id).props.text.toString();
}

function findByText(store: Store, text: string) {
  return store
    .getModelsByFlavour('affine:list')
    .find(m => (m as ListBlockModel).props.text.toString() === text) as
    | ListBlockModel
    | undefined;
}

// ---------------------------------------------------------------------------
// A. Unmodified client over Yjs
// ---------------------------------------------------------------------------
describe('A. unmodified client via Yjs', () => {
  function loadOnOldClient() {
    const seeded = seedNewDoc();
    const oldCollection = createWorkspace('old');
    const { store: oldStore } = openStore('old', oldCollection);
    sync(seeded.store, oldStore);
    return { ...seeded, oldStore };
  }

  test('old client loads the doc and still sees the unknown props', () => {
    const { oldStore, ids } = loadOnOldClient();

    // The old schema has no due/priority/completedAt, but the model keeps the
    // keys (FlatSyncController adds every `prop:*` key it finds in the Y.Map).
    const oldA = oldStore.getBlock(ids.a)!.model as BlockModel;
    expect(oldA.keys).toEqual(
      expect.arrayContaining(['due', 'priority', 'completedAt'])
    );
    expect(modelProps(oldStore, ids.a)).toEqual({
      due: '2026-11-02',
      priority: 3,
      completedAt: 1700000000000,
    });
    expect(yProps(oldStore, ids.a).has).toEqual([true, true, true]);
    // the default-prop pass only fills keys the OLD schema knows about
    expect(yProps(oldStore, ids.b).completedAt).toBeUndefined();
    expect(yProps(oldStore, ids.b).has).toEqual([true, true, false]);
  });

  test('typical old-client edits keep the props, and they merge back', () => {
    const { store, oldStore, ids } = loadOnOldClient();
    const oldA = oldStore.getBlock(ids.a)!.model as unknown as ListBlockModel;
    const oldB = oldStore.getBlock(ids.b)!.model as unknown as ListBlockModel;
    const oldSib = oldStore.getBlock(ids.sib)!.model;

    // edit text
    oldA.props.text.insert(' edited', oldA.props.text.length);
    // toggle with a bare updateBlock (what every pre-fork writer does)
    oldStore.updateBlock(oldB, { checked: true });
    // change type, then change it back
    oldStore.updateBlock(oldA, { type: 'bulleted' });
    oldStore.updateBlock(oldA, { type: 'todo' });
    // indent b under a, then move it back out
    oldStore.moveBlocks([oldB], oldA);
    expect(oldStore.getParent(oldB)?.id).toBe(ids.a);
    oldStore.moveBlocks([oldB], oldStore.getBlock(ids.note)!.model, oldSib);
    // delete a sibling
    oldStore.deleteBlock(oldSib);

    // props still on the old side
    expect(modelProps(oldStore, ids.a)).toEqual({
      due: '2026-11-02',
      priority: 3,
      completedAt: 1700000000000,
    });
    expect(modelProps(oldStore, ids.b)).toMatchObject({
      due: '2026-11-05',
      priority: 1,
    });

    // and back on a new-schema doc
    sync(oldStore, store);
    expect(textOf(store, ids.a)).toBe('task a edited');
    expect(store.hasBlock(ids.sib)).toBe(false);
    expect(modelProps(store, ids.a)).toEqual({
      due: '2026-11-02',
      priority: 3,
      completedAt: 1700000000000,
    });
    expect(modelProps(store, ids.b)).toMatchObject({
      due: '2026-11-05',
      priority: 1,
    });
    expect(yProps(store, ids.a).has).toEqual([true, true, true]);
    expect(yProps(store, ids.b).due).toBe('2026-11-05');
    expect(modelOf(store, ids.b).props.checked).toBe(true);
  });

  test('old-side snapshot export (toSnapshot) does not strip unknown props', async () => {
    const { oldStore, ids } = loadOnOldClient();
    const job = new Transformer({
      schema: oldSchema,
      blobCRUD: new MemoryBlobCRUD(),
      docCRUD: {
        create: () => oldStore,
        get: () => oldStore,
        delete: () => {},
      },
    });
    const snapshot = job.docToSnapshot(oldStore)!;
    const a = findLists(snapshot.blocks).find(l => l.id === ids.a)!;
    expect(a.props).toMatchObject({
      due: '2026-11-02',
      priority: 3,
      completedAt: 1700000000000,
    });
  });

  test('old client re-created doc from the snapshot keeps the props', async () => {
    const { oldStore } = loadOnOldClient();
    const oldCollection = createWorkspace('old');
    oldCollection.storeExtensions = oldExtensions;
    const job = new Transformer({
      schema: oldSchema,
      blobCRUD: oldCollection.blobSync,
      docCRUD: {
        create: id => oldCollection.createDoc(id).getStore({ id }),
        get: id => oldCollection.getDoc(id)?.getStore({ id }) ?? null,
        delete: id => oldCollection.removeDoc(id),
      },
    });
    const snapshot = job.docToSnapshot(oldStore)!;
    snapshot.meta.id = 'doc-copy';
    const copy = (await job.snapshotToDoc(snapshot))!;
    const a = findByText(copy, 'task a');
    expect(a).toBeDefined();
    expect(modelProps(copy, a!.id)).toEqual({
      due: '2026-11-02',
      priority: 3,
      completedAt: 1700000000000,
    });
  });

  test('semantic gotcha: old client unchecking leaves a stale completedAt', () => {
    const { store, oldStore, ids } = loadOnOldClient();
    const oldA = oldStore.getBlock(ids.a)!.model as unknown as ListBlockModel;
    oldStore.updateBlock(oldA, { checked: false });
    sync(oldStore, store);

    // An unmodified client leaves completedAt stale when unchecking;
    // consumers must treat checked as the source of truth and ignore
    // completedAt when checked is false.
    expect(modelOf(store, ids.a).props.checked).toBe(false);
    expect(modelOf(store, ids.a).props.completedAt).toBe(1700000000000);
  });

  test('semantic gotcha: old client checking sets no completedAt', () => {
    const { store, oldStore, ids } = loadOnOldClient();
    const oldB = oldStore.getBlock(ids.b)!.model as unknown as ListBlockModel;
    oldStore.updateBlock(oldB, { checked: true });
    sync(oldStore, store);

    // An unmodified client checks a task without setting completedAt;
    // consumers need a fallback ordering (e.g. meta:updatedAt or doc order).
    expect(modelOf(store, ids.b).props.checked).toBe(true);
    expect(modelOf(store, ids.b).props.completedAt).toBeUndefined();
  });

  test('new client uncheck via setTodoChecked clears completedAt in the Y.Map', () => {
    const { store, ids } = seedNewDoc();
    setTodoChecked(store, modelOf(store, ids.a), false);
    expect(yProps(store, ids.a).has).toEqual([true, true, false]);
  });
});

// ---------------------------------------------------------------------------
// B. Snapshot transformer (what AFFiNE-format zip export/import does)
// ---------------------------------------------------------------------------
describe('B. snapshot transformer', () => {
  function makeJob(kind: Kind) {
    const collection = createWorkspace(kind);
    collection.storeExtensions = kind === 'new' ? newExtensions : oldExtensions;
    const schema = kind === 'new' ? newSchema : oldSchema;
    const job = new Transformer({
      schema,
      blobCRUD: collection.blobSync,
      docCRUD: {
        create: id => collection.createDoc(id).getStore({ id }),
        get: id => collection.getDoc(id)?.getStore({ id }) ?? null,
        delete: id => collection.removeDoc(id),
      },
    });
    return { collection, schema, job };
  }

  const expectedA = {
    due: '2026-11-02',
    priority: 3,
    completedAt: 1700000000000,
  };

  test('new schema: docToSnapshot -> JSON -> snapshotToDoc keeps the props', async () => {
    const { store } = seedNewDoc();
    const { job } = makeJob('new');
    const snapshot = job.docToSnapshot(store)!;
    const lists = findLists(snapshot.blocks);
    expect(listByText(lists, 'task a')!.props).toMatchObject(expectedA);

    const roundTripped = JSON.parse(JSON.stringify(snapshot)) as DocSnapshot;
    roundTripped.meta.id = 'imported';
    const imported = (await job.snapshotToDoc(roundTripped))!;
    const a = findByText(imported, 'task a')!;
    expect(modelProps(imported, a.id)).toEqual(expectedA);
    expect(yProps(imported, a.id).has).toEqual([true, true, true]);
    const b = findByText(imported, 'task b')!;
    expect(modelProps(imported, b.id)).toMatchObject({
      due: '2026-11-05',
      priority: 1,
    });
    // an absent prop stays absent (not written as undefined/null)
    expect(yProps(imported, b.id).has).toEqual([true, true, false]);
  });

  test('new schema: real ZipTransformer.importDocs path keeps the props', async () => {
    const { store } = seedNewDoc();
    const { job } = makeJob('new');
    const snapshot = job.docToSnapshot(store)!;
    snapshot.meta.id = 'zip-doc';
    const zipped = fflate.zipSync({
      'x-zip-doc.snapshot.json': fflate.strToU8(JSON.stringify(snapshot)),
    });

    const target = makeJob('new');
    const [imported] = await ZipTransformer.importDocs(
      target.collection,
      target.schema,
      new Blob([zipped as BlobPart])
    );
    const a = findByText(imported!, 'task a')!;
    expect(modelProps(imported!, a.id)).toEqual(expectedA);
  });

  test('old schema, doc holds the props: snapshot round trip keeps them', async () => {
    const seeded = seedNewDoc();
    const oldCollection = createWorkspace('old');
    const { store: oldStore } = openStore('old', oldCollection);
    sync(seeded.store, oldStore);

    const { job } = makeJob('old');
    const snapshot = job.docToSnapshot(oldStore)!;
    const exportedA = listByText(findLists(snapshot.blocks), 'task a')!;
    // keys come from the Y.Map, not from the old schema
    expect(exportedA.props).toMatchObject(expectedA);

    const roundTripped = JSON.parse(JSON.stringify(snapshot)) as DocSnapshot;
    roundTripped.meta.id = 'imported-old';
    const imported = (await job.snapshotToDoc(roundTripped))!;
    const a = findByText(imported, 'task a')!;
    expect(modelProps(imported, a.id)).toEqual(expectedA);
  });

  test('old schema importing a new-schema snapshot keeps the props', async () => {
    const { store } = seedNewDoc();
    const snapshot = makeJob('new').job.docToSnapshot(store)!;
    snapshot.meta.id = 'into-old';
    const old = makeJob('old');
    const imported = (await old.job.snapshotToDoc(snapshot))!;
    const a = findByText(imported, 'task a')!;
    expect(modelProps(imported, a.id)).toEqual(expectedA);
  });
});

// ---------------------------------------------------------------------------
// C. Copy/paste and duplicate
// ---------------------------------------------------------------------------
describe('C. copy/paste and duplicate', () => {
  const expectedA = {
    due: '2026-11-02',
    priority: 3,
    completedAt: 1700000000000,
  };

  test('clipboard snapshot path (sliceToSnapshot -> JSON -> snapshotToSlice) into another doc', async () => {
    const { store, ids } = seedNewDoc();
    const job = createJob();
    // The clipboard serialises the slice snapshot as JSON on
    // 'BLOCKSUITE/SNAPSHOT' and parses it again on paste.
    const slice = Slice.fromModels(store, [modelOf(store, ids.a)]);
    const snapshot = job.sliceToSnapshot(slice)!;
    const parsed = JSON.parse(JSON.stringify(snapshot));
    expect(findLists(parsed.content[0])[0].props).toMatchObject(expectedA);

    // paste into a different doc
    const target = openStore('new', createWorkspace('new'), 'doc1');
    const root = target.store.addBlock('affine:page');
    const note = target.store.addBlock('affine:note', {}, root);
    const pasted = await job.snapshotToSlice(parsed, target.store, note, 0);
    expect(pasted).toBeDefined();
    const copy = findByText(target.store, 'task a')!;
    expect(copy).toBeDefined();
    expect(modelProps(target.store, copy.id)).toEqual(expectedA);
  });
});

// ---------------------------------------------------------------------------
// D. Text adapters: no place for the props, loss is expected
// ---------------------------------------------------------------------------
describe('D. text adapters (lossy by design)', () => {
  const provider = getProvider();
  const assets = () => new AssetsManager({ blob: new MemoryBlobCRUD() });

  function exportable() {
    const { store } = seedNewDoc();
    const job = createJob();
    return { job, snapshot: job.docToSnapshot(store)! };
  }

  function expectNoTaskProps(snapshot: DocSnapshot) {
    const lists = findLists(snapshot.blocks);
    expect(lists.length).toBeGreaterThan(0);
    for (const l of lists) {
      for (const key of TASK_KEYS) {
        expect(l.props[key]).toBeUndefined();
      }
    }
  }

  test('markdown: export drops the props, re-import has none', async () => {
    const { job, snapshot } = exportable();
    const adapter = new MarkdownAdapter(job, provider);
    const out = await adapter.fromDocSnapshot({ snapshot, assets: assets() });
    // checked state survives as [x]; due/priority/completedAt are not written
    expect(out.file).toContain('[x] task a');
    expect(out.file).toContain('[ ] task b');
    expect(out.file).not.toContain('2026-11-02');
    expect(out.file).not.toContain('1700000000000');

    const back = await adapter.toDocSnapshot({
      file: out.file,
      assets: assets(),
    });
    // Markdown has no slot for task props; they are lost.
    expectNoTaskProps(back);
  });

  test('html: export drops the props, re-import has none', async () => {
    const { job, snapshot } = exportable();
    const adapter = new HtmlAdapter(job, provider);
    const out = await adapter.fromDocSnapshot({ snapshot, assets: assets() });
    expect(out.file).not.toContain('2026-11-02');
    expect(out.file).not.toContain('1700000000000');

    const back = await adapter.toDocSnapshot({
      file: out.file,
      assets: assets(),
    });
    // Html has no slot for task props; they are lost.
    expectNoTaskProps(back);
  });

  test('plain text: export drops the props, re-import has none', async () => {
    const { job, snapshot } = exportable();
    const adapter = new PlainTextAdapter(job, provider);
    const out = await adapter.fromDocSnapshot({ snapshot, assets: assets() });
    expect(out.file).toContain('task a');
    expect(out.file).not.toContain('2026-11-02');
    expect(out.file).not.toContain('1700000000000');

    const back = adapter.toDocSnapshot({
      file: out.file,
      assets: assets(),
    });
    // Plain text has no slot for task props; they are lost.
    // Plain text also drops the list structure itself (re-import yields
    // paragraphs), so no list block, and no task prop, comes back.
    expect(findLists(back.blocks)).toHaveLength(0);
    expect(JSON.stringify(back)).not.toMatch(/"(due|priority|completedAt)"/);
  });

  test('notion html (import only): todo items come in without task props', async () => {
    const html = `<html><body><div class="page-body"><ul id="x" class="to-do-list"><li><div class="checkbox checkbox-on"></div> <span class="to-do-children-checked">task a</span></li></ul></div></body></html>`;
    const adapter = new NotionHtmlAdapter(createJob(), provider);
    const snapshot = await adapter.toDocSnapshot({
      file: html,
      assets: assets(),
    });
    const lists = findLists(snapshot.blocks);
    expect(lists.length).toBeGreaterThan(0);
    for (const l of lists) {
      for (const key of TASK_KEYS) {
        // Notion HTML export has no equivalent fields, nothing to import.
        expect(l.props[key]).toBeUndefined();
      }
    }
  });
});
