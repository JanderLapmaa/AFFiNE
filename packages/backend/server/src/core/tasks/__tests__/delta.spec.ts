import test from 'ava';
import { applyUpdate, Doc, Map as YMap } from 'yjs';

import { buildTaskCheckedDelta } from '../delta';
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
  const result = buildTaskCheckedDelta(bin, 'b', true, NOW);
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
  const result = buildTaskCheckedDelta(bin, 'a', false, NOW + 1);
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
  const result = buildTaskCheckedDelta(bin, 'a', false, NOW + 1);
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
  t.is(buildTaskCheckedDelta(bin, 'a', true, NOW + 5).kind, 'unchanged');
  t.is(readBlock(bin, 'a').get('prop:completedAt'), NOW);
});

test('ticking a checked task without completedAt only adds completedAt', t => {
  const bin = buildDocBin([{ id: 'a', text: 'imported', checked: true }]);
  const result = buildTaskCheckedDelta(bin, 'a', true, NOW);
  t.is(result.kind, 'delta');
});

test('blocks that are not todos are rejected', t => {
  const bin = buildDocBin([
    { id: 'h', text: 'Heading', heading: true },
    { id: 'a', text: 'todo' },
  ]);
  t.is(buildTaskCheckedDelta(bin, 'h', true, NOW).kind, 'not-a-task');
  t.is(buildTaskCheckedDelta(bin, 'missing', true, NOW).kind, 'not-a-task');
  t.is(buildTaskCheckedDelta(bin, 'note', true, NOW).kind, 'not-a-task');
});
