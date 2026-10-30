import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import test from 'ava';
import Sinon from 'sinon';
import { applyUpdate, Doc, encodeStateAsUpdate, Map as YMap } from 'yjs';

import { createModule } from '../../../__tests__/create-module';
import { Mockers } from '../../../__tests__/mocks';
import {
  BadRequest,
  DocActionDenied,
  DocNotFound,
  NotFound,
} from '../../../base';
import { DocRole, Models, WorkspaceRole } from '../../../models';
import { PgWorkspaceDocStorageAdapter } from '../../doc';
import { TASK_EXTRACTOR_VERSION, TaskExtractor } from '../extractor';
import { TaskModule } from '../index';
import { TaskResolver } from '../resolver';
import { TaskService } from '../service';
import { buildDocBin } from './helpers';

const module = await createModule({ imports: [TaskModule] });
const models = module.get(Models);
const db = module.get(PrismaClient);
const storage = module.get(PgWorkspaceDocStorageAdapter);
const extractor = module.get(TaskExtractor);
const service = module.get(TaskService);
const resolver = module.get(TaskResolver);

const owner = await module.create(Mockers.User);

test.after.always(async () => {
  await module.close();
});

async function createWorkspace() {
  return await module.create(Mockers.Workspace, { owner });
}

async function putDoc(workspaceId: string, docId: string, bin: Uint8Array) {
  await db.snapshot.upsert({
    where: { workspaceId_id: { workspaceId, id: docId } },
    create: {
      id: docId,
      workspaceId,
      blob: Buffer.from(bin),
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: owner.id,
      updatedBy: owner.id,
    },
    update: { blob: Buffer.from(bin), updatedAt: new Date() },
  });
}

const pushed = (spaceId: string, docId: string) => ({
  spaceType: 'workspace' as const,
  spaceId,
  docId,
  updates: [],
  timestamp: Date.now(),
});

test('push extracts the doc after the debounce and replaces its rows', async t => {
  const ws = await createWorkspace();
  const docId = randomUUID();
  await models.workspaceTask.ensureState(ws.id);

  await putDoc(
    ws.id,
    docId,
    buildDocBin([
      { id: 'h', text: 'Plan', heading: true },
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second', checked: true, completedAt: 1000 },
      { id: 'empty', text: '  ' },
    ])
  );

  const getDoc = Sinon.spy(storage, 'getDoc');
  t.teardown(() => getDoc.restore());

  // three pushes in the window share one extraction
  extractor.onDocUpdates(pushed(ws.id, docId));
  extractor.onDocUpdates(pushed(ws.id, docId));
  extractor.onDocUpdates(pushed(ws.id, docId));
  t.is((await models.workspaceTask.list(ws.id)).length, 0);
  await extractor.flush();
  t.is(getDoc.callCount, 1);

  const rows = await models.workspaceTask.list(ws.id);
  t.deepEqual(
    rows.map(r => [r.blockId, r.text, r.checked, r.completedAt, r.heading]),
    [
      ['a', 'first', false, null, 'Plan'],
      ['b', 'second', true, 1000, 'Plan'],
    ]
  );
  const revision = (await models.workspaceTask.getState(ws.id))!.revision;
  t.is(revision, 1);

  // an unrelated push does not change the rows nor the revision
  extractor.onDocUpdates(pushed(ws.id, docId));
  await extractor.flush();
  t.is((await models.workspaceTask.getState(ws.id))!.revision, revision);

  // an edit replaces the rows
  await putDoc(
    ws.id,
    docId,
    buildDocBin([{ id: 'a', text: 'first, edited', due: '2026-11-01' }])
  );
  extractor.onDocUpdates(pushed(ws.id, docId));
  await extractor.flush();
  const edited = await models.workspaceTask.list(ws.id);
  t.deepEqual(
    edited.map(r => [r.blockId, r.text, r.due]),
    [['a', 'first, edited', '2026-11-01']]
  );
  t.is((await models.workspaceTask.getState(ws.id))!.revision, revision + 1);
});

test('root, db$ and userdata$ docs and untracked workspaces are ignored', async t => {
  const ws = await createWorkspace();
  const getDoc = Sinon.spy(storage, 'getDoc');
  t.teardown(() => getDoc.restore());

  extractor.onDocUpdates(pushed(ws.id, ws.id));
  extractor.onDocUpdates(pushed(ws.id, `db$${ws.id}$docProperties`));
  extractor.onDocUpdates(pushed(ws.id, `userdata$${owner.id}$x`));
  extractor.onDocUpdates({
    ...pushed(ws.id, 'doc'),
    spaceType: 'userspace',
  });
  await extractor.flush();
  t.is(getDoc.callCount, 0);

  // no state row: nobody asked for the tasks of this workspace yet
  await putDoc(ws.id, 'doc', buildDocBin([{ id: 'a', text: 'x' }]));
  extractor.onDocUpdates(pushed(ws.id, 'doc'));
  await extractor.flush();
  t.is((await models.workspaceTask.list(ws.id)).length, 0);
  t.is(await models.workspaceTask.getState(ws.id), null);
});

test('rows of a doc that no longer exists are removed', async t => {
  const ws = await createWorkspace();
  const docId = randomUUID();
  await models.workspaceTask.ensureState(ws.id);
  await putDoc(ws.id, docId, buildDocBin([{ id: 'a', text: 'gone soon' }]));
  await extractor.extractDoc(ws.id, docId);
  t.is((await models.workspaceTask.list(ws.id)).length, 1);
  const revision = (await models.workspaceTask.getState(ws.id))!.revision;

  await models.doc.delete(ws.id, docId);
  t.true(await extractor.extractDoc(ws.id, docId));
  t.is((await models.workspaceTask.list(ws.id)).length, 0);
  t.is((await models.workspaceTask.getState(ws.id))!.revision, revision + 1);
});

test('backfill extracts every doc, drops orphans and sets the version', async t => {
  const ws = await createWorkspace();
  await putDoc(ws.id, 'doc-1', buildDocBin([{ id: 'a', text: 'one' }]));
  await putDoc(
    ws.id,
    'doc-2',
    buildDocBin([
      { id: 'a', text: 'two' },
      { id: 'b', text: 'three' },
    ])
  );
  await putDoc(ws.id, ws.id, buildDocBin([{ id: 'x', text: 'root' }]));
  // a leftover row of a doc that does not exist
  await models.workspaceTask.replaceDoc(ws.id, 'orphan', [
    {
      blockId: 'a',
      text: 'orphan',
      refs: [],
      heading: null,
      order: 0,
      checked: false,
      due: null,
      priority: null,
      completedAt: null,
    },
  ]);

  const first = await service.list(owner.id, ws.id);
  t.false(first.ready);
  await extractor.backfillSettled(ws.id);

  const state = (await models.workspaceTask.getState(ws.id))!;
  t.is(state.extractorVersion, TASK_EXTRACTOR_VERSION);
  t.truthy(state.backfilledAt);

  const done = await service.list(owner.id, ws.id);
  t.true(done.ready);
  t.deepEqual(
    done.tasks!.map(r => `${r.docId}:${r.blockId}:${r.text}`),
    ['doc-1:a:one', 'doc-2:a:two', 'doc-2:b:three']
  );

  const revisionDone = (await models.workspaceTask.getState(ws.id))!.revision;
  // idempotent
  await extractor.backfill(ws.id);
  t.is((await models.workspaceTask.getState(ws.id))!.revision, revisionDone);
  t.is((await models.workspaceTask.list(ws.id)).length, 3);
});

test('an older extractor version triggers a backfill again', async t => {
  const ws = await createWorkspace();
  await putDoc(ws.id, 'doc-1', buildDocBin([{ id: 'a', text: 'one' }]));
  await models.workspaceTask.markBackfilled(ws.id, TASK_EXTRACTOR_VERSION - 1);
  await db.workspaceTaskState.update({
    where: { workspaceId: ws.id },
    data: { extractorVersion: 0 },
  });

  const listed = await service.list(owner.id, ws.id);
  t.false(listed.ready);
  await extractor.backfillSettled(ws.id);
  t.is(
    (await models.workspaceTask.getState(ws.id))!.extractorVersion,
    TASK_EXTRACTOR_VERSION
  );
  t.is((await models.workspaceTask.list(ws.id)).length, 1);
});

test('the list only holds tasks of docs the user can read', async t => {
  const ws = await createWorkspace();
  const member = await module.create(Mockers.User);
  await module.create(Mockers.WorkspaceUser, {
    workspaceId: ws.id,
    userId: member.id,
    type: WorkspaceRole.Collaborator,
  });
  await module.create(Mockers.DocMeta, {
    workspaceId: ws.id,
    docId: 'open',
    defaultRole: DocRole.Editor,
  });
  await module.create(Mockers.DocMeta, {
    workspaceId: ws.id,
    docId: 'secret',
    defaultRole: DocRole.None,
  });
  await putDoc(ws.id, 'open', buildDocBin([{ id: 'a', text: 'visible' }]));
  await putDoc(ws.id, 'secret', buildDocBin([{ id: 'a', text: 'hidden' }]));

  await service.list(owner.id, ws.id);
  await extractor.backfillSettled(ws.id);

  const asOwner = await service.list(owner.id, ws.id);
  t.deepEqual(asOwner.tasks!.map(r => r.docId).sort(), ['open', 'secret']);
  const asMember = await service.list(member.id, ws.id);
  t.deepEqual(
    asMember.tasks!.map(r => r.text),
    ['visible']
  );
});

test('an unchanged etag returns no tasks', async t => {
  const ws = await createWorkspace();
  await putDoc(ws.id, 'doc-1', buildDocBin([{ id: 'a', text: 'one' }]));
  await service.list(owner.id, ws.id);
  await extractor.backfillSettled(ws.id);

  const current = await service.list(owner.id, ws.id);
  t.is(current.tasks!.length, 1);
  const same = await service.list(owner.id, ws.id, current.etag);
  t.is(same.tasks, null);
  t.is(same.etag, current.etag);
  t.true(same.ready);

  await putDoc(ws.id, 'doc-1', buildDocBin([{ id: 'a', text: 'one!' }]));
  await extractor.extractDoc(ws.id, 'doc-1');
  const changed = await service.list(owner.id, ws.id, current.etag);
  t.not(changed.etag, current.etag);
  t.is(changed.tasks!.length, 1);
});

test('updateTask ticks and unticks the doc and the row', async t => {
  const ws = await createWorkspace();
  await putDoc(
    ws.id,
    'doc-1',
    buildDocBin([
      { id: 'a', text: 'one' },
      { id: 'b', text: 'two' },
    ])
  );
  await service.list(owner.id, ws.id);
  await extractor.backfillSettled(ws.id);
  const before = await service.list(owner.id, ws.id);

  const ticked = await resolver.updateTask(
    owner as never,
    ws.id,
    'doc-1',
    'a',
    { checked: true }
  );
  t.true(ticked!.checked);
  t.is(typeof ticked!.completedAt, 'number');

  // the stored doc has the change, and only that
  const record = (await storage.getDoc(ws.id, 'doc-1'))!;
  const doc = new Doc();
  applyUpdate(doc, record.bin);
  const blocks = doc.getMap<YMap<unknown>>('blocks');
  t.is(blocks.get('a')!.get('prop:checked'), true);
  t.is(blocks.get('a')!.get('prop:completedAt'), ticked!.completedAt);
  t.is(blocks.get('b')!.get('prop:checked'), undefined);

  // the list shows it at once, with a new revision
  const after = await service.list(owner.id, ws.id, before.etag);
  t.not(after.etag, before.etag);
  t.true(after.tasks!.find(r => r.blockId === 'a')!.checked);

  // a push event went out for the other clients
  const pushes = module.event.emitAsync
    .getCalls()
    .filter(c => c.args[0] === 'doc.updates.pushed')
    .map(c => c.args[1] as Events['doc.updates.pushed']);
  const event = pushes.find(p => p.docId === 'doc-1');
  t.is(event?.editor, owner.id);

  const unticked = await resolver.updateTask(
    owner as never,
    ws.id,
    'doc-1',
    'a',
    { checked: false }
  );
  t.false(unticked!.checked);
  t.is(unticked!.completedAt, null);
  const doc2 = new Doc();
  applyUpdate(doc2, (await storage.getDoc(ws.id, 'doc-1'))!.bin);
  const block = doc2.getMap<YMap<unknown>>('blocks').get('a')!;
  t.is(block.get('prop:checked'), false);
  t.false(block.has('prop:completedAt'));
  t.true(encodeStateAsUpdate(doc2).byteLength > 0);
});

test('updateTask rejects blocks the list does not show', async t => {
  const ws = await createWorkspace();
  await putDoc(
    ws.id,
    'doc-1',
    buildDocBin([
      { id: 'a', text: 'one' },
      { id: 'blank', text: ' ' },
    ])
  );
  const before = await storage.getDoc(ws.id, 'doc-1');
  await t.throwsAsync(
    resolver.updateTask(owner as never, ws.id, 'doc-1', 'blank', {
      checked: true,
    }),
    { instanceOf: NotFound }
  );
  await t.throwsAsync(
    resolver.updateTask(owner as never, ws.id, 'doc-1', 'note', {
      checked: true,
    }),
    { instanceOf: NotFound }
  );
  await t.throwsAsync(
    resolver.updateTask(owner as never, ws.id, 'missing-doc', 'a', {
      checked: true,
    }),
    { instanceOf: DocNotFound }
  );
  // nothing was written
  const after = await storage.getDoc(ws.id, 'doc-1');
  t.deepEqual(Buffer.from(after!.bin), Buffer.from(before!.bin));
});

test('updateTask is denied without Doc.Update', async t => {
  const ws = await createWorkspace();
  const member = await module.create(Mockers.User);
  await module.create(Mockers.WorkspaceUser, {
    workspaceId: ws.id,
    userId: member.id,
    type: WorkspaceRole.Collaborator,
  });
  await module.create(Mockers.DocMeta, {
    workspaceId: ws.id,
    docId: 'read-only',
    defaultRole: DocRole.Reader,
  });
  await putDoc(ws.id, 'read-only', buildDocBin([{ id: 'a', text: 'one' }]));

  await t.throwsAsync(
    resolver.updateTask(member as never, ws.id, 'read-only', 'a', {
      checked: true,
    }),
    { instanceOf: DocActionDenied }
  );
  const doc = new Doc();
  applyUpdate(doc, (await storage.getDoc(ws.id, 'read-only'))!.bin);
  t.is(
    doc.getMap<YMap<unknown>>('blocks').get('a')!.get('prop:checked'),
    undefined
  );
});

test('a doc that gets rows during the backfill survives it', async t => {
  const ws = await createWorkspace();
  await putDoc(ws.id, 'doc-1', buildDocBin([{ id: 'a', text: 'one' }]));
  const original = extractor.extractDoc.bind(extractor);
  let injected = false;
  const stub = Sinon.stub(extractor, 'extractDoc').callsFake(
    async (workspaceId, docId) => {
      if (!injected) {
        injected = true;
        await putDoc(ws.id, 'doc-new', buildDocBin([{ id: 'a', text: 'new' }]));
        await original(ws.id, 'doc-new');
      }
      return await original(workspaceId, docId);
    }
  );
  t.teardown(() => stub.restore());

  await extractor.backfill(ws.id);
  const rows = await models.workspaceTask.list(ws.id);
  t.deepEqual(rows.map(r => r.docId).sort(), ['doc-1', 'doc-new']);
});

test('one bad doc does not fail the backfill', async t => {
  const ws = await createWorkspace();
  await putDoc(ws.id, 'good', buildDocBin([{ id: 'a', text: 'one' }]));
  await putDoc(ws.id, 'bad', buildDocBin([{ id: 'a', text: 'two' }]));
  const original = extractor.extractDoc.bind(extractor);
  const stub = Sinon.stub(extractor, 'extractDoc').callsFake(
    async (workspaceId, docId) => {
      if (docId === 'bad') throw new Error('boom');
      return await original(workspaceId, docId);
    }
  );
  t.teardown(() => stub.restore());

  await extractor.backfill(ws.id);
  const state = (await models.workspaceTask.getState(ws.id))!;
  t.is(state.extractorVersion, TASK_EXTRACTOR_VERSION);
  t.deepEqual(
    (await models.workspaceTask.list(ws.id)).map(r => r.docId),
    ['good']
  );
});

test('completedAt is stored as whole milliseconds', async t => {
  const ws = await createWorkspace();
  await models.workspaceTask.ensureState(ws.id);
  await putDoc(
    ws.id,
    'doc-1',
    buildDocBin([
      { id: 'a', text: 'frac', checked: true, completedAt: 1000.7 },
      { id: 'b', text: 'huge', checked: true, completedAt: 1e300 },
    ])
  );
  await extractor.extractDoc(ws.id, 'doc-1');
  const rows = await models.workspaceTask.list(ws.id);
  t.deepEqual(
    rows.map(r => [r.blockId, r.completedAt]),
    [
      ['a', 1000],
      ['b', null],
    ]
  );
});

test('an older read can not overwrite newer rows', async t => {
  const ws = await createWorkspace();
  await models.workspaceTask.ensureState(ws.id);
  await putDoc(ws.id, 'doc-1', buildDocBin([{ id: 'a', text: 'v0' }]));

  const original = storage.getDoc.bind(storage);
  let calls = 0;
  const stub = Sinon.stub(storage, 'getDoc').callsFake(async (w, d) => {
    const record = await original(w, d);
    // the first read is slow: it returns the old content after the write
    if (calls++ === 0) await new Promise(r => setTimeout(r, 300));
    return record;
  });
  t.teardown(() => stub.restore());

  const stale = extractor.extractDoc(ws.id, 'doc-1');
  await new Promise(r => setTimeout(r, 50));
  await putDoc(ws.id, 'doc-1', buildDocBin([{ id: 'a', text: 'v1' }]));
  const fresh = extractor.extractDoc(ws.id, 'doc-1');
  await Promise.all([stale, fresh]);

  t.deepEqual(
    (await models.workspaceTask.list(ws.id)).map(r => r.text),
    ['v1']
  );
});

test('the etag changes when the docs a user can read change', async t => {
  const ws = await createWorkspace();
  const member = await module.create(Mockers.User);
  await module.create(Mockers.WorkspaceUser, {
    workspaceId: ws.id,
    userId: member.id,
    type: WorkspaceRole.Collaborator,
  });
  await module.create(Mockers.DocMeta, {
    workspaceId: ws.id,
    docId: 'doc-1',
    defaultRole: DocRole.Editor,
  });
  await putDoc(ws.id, 'doc-1', buildDocBin([{ id: 'a', text: 'one' }]));
  await service.list(member.id, ws.id);
  await extractor.backfillSettled(ws.id);

  const visible = await service.list(member.id, ws.id);
  t.is(visible.tasks!.length, 1);
  await db.docAccessPolicy.update({
    where: { workspaceId_docId: { workspaceId: ws.id, docId: 'doc-1' } },
    data: { memberDefaultRole: 'none' },
  });
  const hidden = await service.list(member.id, ws.id, visible.etag);
  t.not(hidden.etag, visible.etag);
  t.deepEqual(hidden.tasks, []);
});

test('ticking in an untracked workspace starts tracking through the backfill', async t => {
  const ws = await createWorkspace();
  await putDoc(ws.id, 'doc-1', buildDocBin([{ id: 'a', text: 'one' }]));
  t.is(await models.workspaceTask.getState(ws.id), null);

  const task = await service.update(owner.id, ws.id, 'doc-1', 'a', {
    checked: true,
  });
  t.true(task.checked);
  await extractor.backfillSettled(ws.id);
  const state = (await models.workspaceTask.getState(ws.id))!;
  t.is(state.extractorVersion, TASK_EXTRACTOR_VERSION);
  t.true((await models.workspaceTask.list(ws.id))[0].checked);
});

test('flush continues after a failing doc', async t => {
  const ws = await createWorkspace();
  await models.workspaceTask.ensureState(ws.id);
  await putDoc(ws.id, 'good', buildDocBin([{ id: 'a', text: 'one' }]));
  const original = extractor.extractDoc.bind(extractor);
  const stub = Sinon.stub(extractor, 'extractDoc').callsFake(
    async (workspaceId, docId) => {
      if (docId === 'bad') throw new Error('boom');
      return await original(workspaceId, docId);
    }
  );
  t.teardown(() => stub.restore());

  extractor.schedule(ws.id, 'bad');
  extractor.schedule(ws.id, 'good');
  await extractor.flush();
  t.is((await models.workspaceTask.list(ws.id)).length, 1);
});

test('updateTask sets and clears due and priority, and rejects bad input', async t => {
  const ws = await createWorkspace();
  await putDoc(ws.id, 'doc-1', buildDocBin([{ id: 'a', text: 'one' }]));
  await service.list(owner.id, ws.id);
  await extractor.backfillSettled(ws.id);

  const set = await resolver.updateTask(owner as never, ws.id, 'doc-1', 'a', {
    due: '2026-11-05',
    priority: 3,
  });
  t.is(set.due, '2026-11-05');
  t.is(set.priority, 3);
  t.false(set.checked);
  const row = (await models.workspaceTask.list(ws.id))[0];
  t.is(row.due, '2026-11-05');
  t.is(row.priority, 3);

  // no change: nothing is pushed
  const pushes = () =>
    module.event.emitAsync
      .getCalls()
      .filter(c => c.args[0] === 'doc.updates.pushed').length;
  const count = pushes();
  await resolver.updateTask(owner as never, ws.id, 'doc-1', 'a', {
    due: '2026-11-05',
  });
  t.is(pushes(), count);

  const cleared = await resolver.updateTask(
    owner as never,
    ws.id,
    'doc-1',
    'a',
    {
      due: null,
      priority: 0,
    }
  );
  t.is(cleared.due, null);
  t.is(cleared.priority, null);

  const before = await storage.getDoc(ws.id, 'doc-1');
  await t.throwsAsync(
    resolver.updateTask(owner as never, ws.id, 'doc-1', 'a', { due: 'soon' }),
    { instanceOf: BadRequest }
  );
  await t.throwsAsync(
    resolver.updateTask(owner as never, ws.id, 'doc-1', 'a', { priority: 9 }),
    { instanceOf: BadRequest }
  );
  const after = await storage.getDoc(ws.id, 'doc-1');
  t.deepEqual(Buffer.from(after!.bin), Buffer.from(before!.bin));
});
