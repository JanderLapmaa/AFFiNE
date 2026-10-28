import { setTodoChecked } from '@blocksuite/affine-block-list';
import {
  getTodoCheckedProps,
  type ListBlockModel,
  ListBlockSchemaExtension,
  NoteBlockSchemaExtension,
  RootBlockSchemaExtension,
} from '@blocksuite/affine-model';
import {
  createAutoIncrementIdGenerator,
  TestWorkspace,
} from '@blocksuite/store/test';
import { describe, expect, test } from 'vitest';

const extensions = [
  RootBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ListBlockSchemaExtension,
];

function createTodo(props: Partial<ListBlockModel['props']> = {}) {
  const collection = new TestWorkspace({
    id: 'test-collection',
    idGenerator: createAutoIncrementIdGenerator(),
  });
  collection.meta.initialize();
  const doc = collection.createDoc('doc0');
  const store = doc.getStore({ extensions });
  doc.load();
  const root = store.addBlock('affine:page');
  const note = store.addBlock('affine:note', {}, root);
  const id = store.addBlock('affine:list', { type: 'todo', ...props }, note);
  const model = store.getBlock(id)!.model as ListBlockModel;
  return { store, model };
}

describe('todo list props', () => {
  test('due, priority and completedAt default to undefined', () => {
    const { model } = createTodo();
    expect(model.props.due).toBeUndefined();
    expect(model.props.priority).toBeUndefined();
    expect(model.props.completedAt).toBeUndefined();
  });

  test('props survive a store round trip', () => {
    const { store, model } = createTodo();
    store.updateBlock(model, {
      due: '2026-11-02',
      priority: 3,
      completedAt: 5,
    });

    expect(model.props.due).toBe('2026-11-02');
    expect(model.props.priority).toBe(3);
    expect(model.props.completedAt).toBe(5);

    const yBlock = store.doc.yBlocks.get(model.id)!;
    expect(yBlock.get('prop:due')).toBe('2026-11-02');
    expect(yBlock.get('prop:priority')).toBe(3);
    expect(yBlock.get('prop:completedAt')).toBe(5);
  });

  test('toggling with the shared helper keeps completedAt in step', () => {
    const { store, model } = createTodo();

    setTodoChecked(store, model, true, 1234);
    expect(model.props.checked).toBe(true);
    expect(model.props.completedAt).toBe(1234);

    setTodoChecked(store, model, false);
    expect(model.props.checked).toBe(false);
    expect(model.props.completedAt).toBeUndefined();
    expect(store.doc.yBlocks.get(model.id)!.has('prop:completedAt')).toBe(
      false
    );
  });

  test('a block created already checked gets completedAt', () => {
    const { model } = createTodo(getTodoCheckedProps(true, 99));
    expect(model.props.checked).toBe(true);
    expect(model.props.completedAt).toBe(99);
  });

  test('undo of a check restores checked and completedAt', () => {
    const { store, model } = createTodo();

    store.captureSync();
    setTodoChecked(store, model, true, 1234);
    expect(model.props.completedAt).toBe(1234);

    store.undo();
    expect(model.props.checked).toBe(false);
    expect(model.props.completedAt).toBeUndefined();
  });

  test('undo of an uncheck restores completedAt', () => {
    const { store, model } = createTodo();
    setTodoChecked(store, model, true, 1234);

    store.captureSync();
    setTodoChecked(store, model, false);
    expect(model.props.completedAt).toBeUndefined();

    store.undo();
    expect(model.props.checked).toBe(true);
    expect(model.props.completedAt).toBe(1234);
  });

  test('readonly store: toggling changes nothing', () => {
    const { store, model } = createTodo();
    setTodoChecked(store, model, true, 1234);

    store.readonly = true;
    setTodoChecked(store, model, false);
    expect(model.props.checked).toBe(true);
    expect(model.props.completedAt).toBe(1234);
    expect(store.doc.yBlocks.get(model.id)!.get('prop:completedAt')).toBe(1234);
  });
});
