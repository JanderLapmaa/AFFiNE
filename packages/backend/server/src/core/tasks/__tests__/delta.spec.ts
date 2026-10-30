import test from 'ava';
import { applyUpdate, Doc, encodeStateAsUpdate, Map as YMap } from 'yjs';

import { BadRequest } from '../../../base';
import { buildTaskDelta, validateTaskChanges } from '../delta';
import { buildDocBin } from './helpers';

const NOW = 1_767_225_600_000;

function readBlock(bin: Uint8Array, id: string) {
  const doc = new Doc();
  applyUpdate(doc, bin);
  return doc.getMap<YMap<unknown>>('blocks').get(id)!;
}

test('ticking sets checked and completedAt in a small delta', t => {
  const bin = buildDocBin([
    { id: 'a', text: 'first' },
    { id: 'b', text: 'second' },
  ]);
  const result = buildTaskDelta(bin, 'b', { checked: true }, NOW);
  t.is(result.kind, 'delta');
  if (result.kind !== 'delta') return;

  // applying the delta on top of the original gives the change
  const doc = new Doc();
  applyUpdate(doc, bin);
  applyUpdate(doc, result.update);
  const block = doc.getMap<YMap<unknown>>('blocks').get('b')!;
  t.is(block.get('prop:checked'), true);
  t.is(block.get('prop:completedAt'), NOW);
  t.is(
    doc.getMap<YMap<unknown>>('blocks').get('a')!.get('prop:checked'),
    undefined
  );

  // far smaller than the doc, and applying it twice changes nothing
  t.true(result.update.byteLength < 100);
  t.true(result.update.byteLength < bin.byteLength);
  applyUpdate(doc, result.update);
  t.is(block.get('prop:completedAt'), NOW);
});

test('unticking clears checked and removes completedAt', t => {
  const bin = buildDocBin([
    { id: 'a', text: 'done', checked: true, completedAt: NOW },
  ]);
  const result = buildTaskDelta(bin, 'a', { checked: false }, NOW + 1);
  t.is(result.kind, 'delta');
  if (result.kind !== 'delta') return;

  const doc = new Doc();
  applyUpdate(doc, bin);
  applyUpdate(doc, result.update);
  const block = doc.getMap<YMap<unknown>>('blocks').get('a')!;
  t.is(block.get('prop:checked'), false);
  t.false(block.has('prop:completedAt'));
});

test('a stale completedAt on an unchecked task is removed by unticking', t => {
  const bin = buildDocBin([
    { id: 'a', text: 'stale', checked: false, completedAt: NOW },
  ]);
  const result = buildTaskDelta(bin, 'a', { checked: false }, NOW + 1);
  t.is(result.kind, 'delta');
  if (result.kind !== 'delta') return;
  const doc = new Doc();
  applyUpdate(doc, bin);
  applyUpdate(doc, result.update);
  t.false(
    doc.getMap<YMap<unknown>>('blocks').get('a')!.has('prop:completedAt')
  );
});

test('an already ticked task keeps its completedAt', t => {
  const bin = buildDocBin([
    { id: 'a', text: 'done', checked: true, completedAt: NOW },
  ]);
  t.is(buildTaskDelta(bin, 'a', { checked: true }, NOW + 5).kind, 'unchanged');
  t.is(readBlock(bin, 'a').get('prop:completedAt'), NOW);
});

test('ticking a checked task without completedAt only adds completedAt', t => {
  const bin = buildDocBin([{ id: 'a', text: 'imported', checked: true }]);
  const result = buildTaskDelta(bin, 'a', { checked: true }, NOW);
  t.is(result.kind, 'delta');
});

test('blocks that are not todos are rejected', t => {
  const bin = buildDocBin([
    { id: 'h', text: 'Heading', heading: true },
    { id: 'a', text: 'todo' },
  ]);
  t.is(buildTaskDelta(bin, 'h', { checked: true }, NOW).kind, 'not-a-task');
  t.is(
    buildTaskDelta(bin, 'missing', { checked: true }, NOW).kind,
    'not-a-task'
  );
  t.is(buildTaskDelta(bin, 'note', { checked: true }, NOW).kind, 'not-a-task');
});

function applied(bin: Uint8Array, update: Uint8Array) {
  const doc = new Doc();
  applyUpdate(doc, bin);
  applyUpdate(doc, update);
  return doc;
}

test('due and priority are set and cleared', t => {
  const bin = buildDocBin([{ id: 'a', text: 'one' }]);
  const set = buildTaskDelta(bin, 'a', { due: '2026-11-05', priority: 2 }, NOW);
  if (set.kind !== 'delta') return t.fail();
  t.true(set.update.byteLength < 100);
  const block = applied(bin, set.update)
    .getMap<YMap<unknown>>('blocks')
    .get('a')!;
  t.is(block.get('prop:due'), '2026-11-05');
  t.is(block.get('prop:priority'), 2);
  t.is(block.get('prop:checked'), undefined);

  const withProps = encodeBin(applied(bin, set.update));
  // clearing with null, and priority 0 clears like the client
  for (const changes of [
    { due: null, priority: null },
    { due: null, priority: 0 },
  ]) {
    const clear = buildTaskDelta(withProps, 'a', changes, NOW);
    if (clear.kind !== 'delta') return t.fail();
    const cleared = applied(withProps, clear.update)
      .getMap<YMap<unknown>>('blocks')
      .get('a')!;
    t.false(cleared.has('prop:due'));
    t.false(cleared.has('prop:priority'));
  }
});

test('a combined change is one delta, omitted fields stay', t => {
  const bin = buildDocBin([
    { id: 'a', text: 'one', due: '2026-11-01', priority: 3 },
  ]);
  const result = buildTaskDelta(
    bin,
    'a',
    { checked: true, due: '2026-12-24' },
    NOW
  );
  if (result.kind !== 'delta') return t.fail();
  const block = applied(bin, result.update)
    .getMap<YMap<unknown>>('blocks')
    .get('a')!;
  t.is(block.get('prop:checked'), true);
  t.is(block.get('prop:completedAt'), NOW);
  t.is(block.get('prop:due'), '2026-12-24');
  t.is(block.get('prop:priority'), 3);
});

test('requesting the current values changes nothing', t => {
  const bin = buildDocBin([
    { id: 'a', text: 'one', due: '2026-11-01', priority: 1 },
    { id: 'b', text: 'two' },
  ]);
  t.is(
    buildTaskDelta(bin, 'a', { due: '2026-11-01', priority: 1 }, NOW).kind,
    'unchanged'
  );
  t.is(buildTaskDelta(bin, 'a', {}, NOW).kind, 'unchanged');
  t.is(
    buildTaskDelta(bin, 'b', { due: null, priority: 0, checked: false }, NOW)
      .kind,
    'unchanged'
  );
});

test('invalid due and priority are rejected', t => {
  for (const changes of [
    { due: '2026-1-5' },
    { due: '2026-02-30' },
    { due: 'tomorrow' },
    { priority: 4 },
    { priority: -1 },
    { priority: 1.5 },
  ]) {
    t.throws(() => validateTaskChanges(changes), { instanceOf: BadRequest });
  }
  t.notThrows(() =>
    validateTaskChanges({ due: '2026-02-28', priority: 0, checked: true })
  );
  t.notThrows(() => validateTaskChanges({ due: null, priority: null }));
});

function encodeBin(doc: Doc) {
  return encodeStateAsUpdate(doc);
}
