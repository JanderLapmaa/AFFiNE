import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';
import { applyUpdate, Doc as YDoc } from 'yjs';

import { readDocTasks } from '../src/task-fields';

const fixtures = path.join(
  import.meta.dirname,
  '../../native/fixtures/tasks.ydoc'
);

function loadFixture() {
  const ydoc = new YDoc({ guid: 'tasks-fixture' });
  applyUpdate(ydoc, readFileSync(fixtures));
  return ydoc;
}

test('readDocTasks returns the fixture todos in document order', () => {
  const expected = JSON.parse(
    readFileSync(`${fixtures}.expected.json`, 'utf8')
  );
  const rows = readDocTasks(loadFixture());
  const byId = Object.fromEntries(rows.map(r => [r.blockId, r]));

  // empty todos (blank text, no reference) are not tasks
  expect(byId['t-empty']).toBeUndefined();
  // a todo holding only a doc reference is
  expect(byId['t-refs']).toBeDefined();
  expect(byId['t-refs'].refs.length).toBeGreaterThan(0);
  expect(byId['t-refs'].refs[0][1]).toBe('doc-b');

  // document order
  const orders = rows.map(r => r.order);
  expect(orders).toEqual([...orders].sort((a, b) => a - b));

  // same fields as the indexer's `additional`
  for (const row of rows) {
    const add = expected[row.blockId];
    expect(add, row.blockId).toBeDefined();
    expect(row.checked).toBe(add.checked);
    expect(row.due).toBe(add.due ?? null);
    expect(row.priority).toBe(add.priority ?? null);
    expect(row.heading).toBe(add.heading ?? null);
    expect(row.order).toBe(add.order);
    expect(row.refs).toEqual(add.refs ?? []);
  }

  expect(byId['t-under-h1-checked']).toMatchObject({
    checked: true,
    completedAt: 1767225600000,
    heading: 'Alpha',
    text: 'checked',
  });
  expect(byId['t-due-priority']).toMatchObject({
    due: '2026-01-05',
    priority: 3,
  });
  // invalid due / priority are dropped
  expect(byId['t-bad-due'].due).toBeNull();
  expect(byId['t-out-of-range'].priority).toBeNull();
  // a stale completedAt on an unchecked task is ignored
  expect(byId['t-stale-completed'].checked).toBe(false);
  expect(byId['t-stale-completed'].completedAt).toBeNull();
  // todo before any heading has none; nested todo is kept
  expect(byId['t-before-heading'].heading).toBeNull();
  expect(byId['t-nested'].heading).toBe('Beta');
});

test('readDocTasks of a doc without blocks is empty', () => {
  expect(readDocTasks(new YDoc())).toEqual([]);
});
