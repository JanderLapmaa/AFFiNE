import {
  Array as YArray,
  Doc,
  encodeStateAsUpdate,
  Map as YMap,
  Text,
} from 'yjs';

export interface TodoSpec {
  id: string;
  text: string;
  checked?: boolean;
  completedAt?: number;
  due?: string;
  /** a heading paragraph instead of a todo */
  heading?: boolean;
}

/** A page > note > blocks doc holding the given blocks in order. */
export function buildDoc(blocks: TodoSpec[]) {
  const doc = new Doc();
  const map = doc.getMap<YMap<unknown>>('blocks');
  doc.transact(() => {
    const create = (
      id: string,
      flavour: string,
      props: Record<string, unknown>,
      text?: string,
      children: string[] = []
    ) => {
      const block = new YMap<unknown>();
      map.set(id, block);
      block.set('sys:id', id);
      block.set('sys:flavour', flavour);
      const list = new YArray<string>();
      list.push(children);
      block.set('sys:children', list);
      for (const [key, value] of Object.entries(props)) {
        block.set(`prop:${key}`, value);
      }
      if (text !== undefined) {
        const yText = new Text();
        yText.insert(0, text);
        block.set('prop:text', yText);
      }
    };
    create('page', 'affine:page', {}, 'Title', ['note']);
    create(
      'note',
      'affine:note',
      {},
      undefined,
      blocks.map(b => b.id)
    );
    for (const b of blocks) {
      if (b.heading) {
        create(b.id, 'affine:paragraph', { type: 'h1' }, b.text);
        continue;
      }
      create(
        b.id,
        'affine:list',
        {
          type: 'todo',
          ...(b.checked !== undefined ? { checked: b.checked } : {}),
          ...(b.completedAt !== undefined
            ? { completedAt: b.completedAt }
            : {}),
          ...(b.due ? { due: b.due } : {}),
        },
        b.text
      );
    }
  });
  return doc;
}

export function buildDocBin(blocks: TodoSpec[]) {
  return encodeStateAsUpdate(buildDoc(blocks));
}
