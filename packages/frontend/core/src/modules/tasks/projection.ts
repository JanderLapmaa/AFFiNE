import { addDays, localDay } from './date';
import type {
  TaskGroup,
  TaskPriority,
  TaskRow,
  TasksCounts,
  TasksViewId,
} from './types';

/** A todo block as stored in the index row's `additional` JSON. */
export interface IndexedTask {
  docId: string;
  blockId: string;
  title: string;
  checked: boolean;
  due: string | null;
  priority: TaskPriority;
  completedAt: number | null;
  heading: string | null;
  order: number | null;
  /** Linked-doc references: UTF-16 offset of the placeholder in `title`, doc id. */
  refs: [number, string][];
}

/** Doc-level data from the workspace doc records. */
export interface DocInfo {
  title: string;
  template: boolean;
  createDate?: number;
  updatedDate?: number;
}

const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;

const stringField = (value: unknown) =>
  typeof value === 'string'
    ? value
    : Array.isArray(value) && typeof value[0] === 'string'
      ? value[0]
      : null;

const parseRefs = (value: unknown): [number, string][] =>
  Array.isArray(value)
    ? value.flatMap(ref =>
        Array.isArray(ref) &&
        Number.isInteger(ref[0]) &&
        ref[0] >= 0 &&
        typeof ref[1] === 'string'
          ? [[ref[0], ref[1]] as [number, string]]
          : []
      )
    : [];

/**
 * The text with each reference placeholder replaced by the title of the doc it
 * links to. Offsets are UTF-16 (JS string indices), so replacing from the end
 * keeps earlier ones valid.
 */
function titleWithRefs(
  task: IndexedTask,
  refTitles: ReadonlyMap<string, string>
) {
  let title = task.title;
  for (const [offset, docId] of task.refs.toReversed()) {
    if (offset >= title.length) continue;
    title = `${title.slice(0, offset)}${refTitles.get(docId) ?? ''}${title.slice(offset + 1)}`;
  }
  return title;
}

/** Parses one index node's fields; returns null for anything that isn't a todo. */
export function parseIndexedTask(
  fields: Record<string, unknown>
): IndexedTask | null {
  const docId = stringField(fields.docId);
  const blockId = stringField(fields.blockId);
  const additional = stringField(fields.additional);
  if (!docId || !blockId || !additional) return null;
  let extra: Record<string, unknown>;
  try {
    const parsed = JSON.parse(additional);
    if (!parsed || typeof parsed !== 'object') return null;
    extra = parsed;
  } catch {
    return null;
  }
  if (extra.listType !== 'todo') return null;
  const priority = extra.priority;
  const heading = extra.heading;
  return {
    docId,
    blockId,
    title: stringField(fields.content) ?? '',
    checked: extra.checked === true,
    due:
      typeof extra.due === 'string' && DUE_RE.test(extra.due)
        ? extra.due
        : null,
    priority: priority === 1 || priority === 2 || priority === 3 ? priority : 0,
    completedAt:
      typeof extra.completedAt === 'number' &&
      Number.isFinite(extra.completedAt)
        ? extra.completedAt
        : null,
    heading: typeof heading === 'string' && heading !== '' ? heading : null,
    order:
      typeof extra.order === 'number' && Number.isFinite(extra.order)
        ? extra.order
        : null,
    refs: parseRefs(extra.refs),
  };
}

interface Item {
  row: TaskRow;
  order: number;
  docCreatedAt: number;
}

function buildItems(
  tasks: readonly IndexedTask[],
  docs: ReadonlyMap<string, DocInfo>,
  today: string,
  refTitles: ReadonlyMap<string, string>
): Item[] {
  const items: Item[] = [];
  for (const task of tasks) {
    const doc = docs.get(task.docId);
    // Trashed docs have no info, templates are not part of the task list.
    if (!doc || doc.template) continue;
    // An empty todo (Enter after the last one) is not a task; one holding
    // only a doc reference is not empty.
    if (!task.title.trim() && !task.refs.length) continue;
    const completedAt = task.checked
      ? (task.completedAt ?? doc.updatedDate ?? doc.createDate ?? 0)
      : null;
    items.push({
      row: {
        id: `${task.docId}:${task.blockId}`,
        docId: task.docId,
        blockId: task.blockId,
        title: titleWithRefs(task, refTitles),
        due: task.due,
        priority: task.priority,
        checked: task.checked,
        completedAt,
        docTitle: doc.title,
        heading: task.heading,
        overdue: !task.checked && task.due !== null && task.due < today,
      },
      order: task.order ?? Number.POSITIVE_INFINITY,
      docCreatedAt: doc.createDate ?? 0,
    });
  }
  return items;
}

/**
 * Checked tasks stay crossed off in their normal views: a dated task while
 * its due date is today or later, an undated one until its completion day ends.
 */
function isVisibleInNormalViews(row: TaskRow, today: string) {
  if (!row.checked) return true;
  if (row.due !== null) return row.due >= today;
  return localDay(row.completedAt ?? 0) >= today;
}

function isInView(view: TasksViewId, row: TaskRow, today: string) {
  switch (view) {
    case 'completed':
      return row.checked;
    case 'inbox':
      return row.due === null;
    case 'today':
      return row.due !== null && row.due <= today;
    case 'tomorrow':
      return row.due === addDays(today, 1);
    case 'next7':
      return row.due !== null && row.due <= addDays(today, 6);
    case 'all':
      return true;
  }
}

const cmp = (a: number | string, b: number | string) =>
  a < b ? -1 : a > b ? 1 : 0;

/** Open before completed, priority high to low, document position, doc id. */
function compareInGroup(a: Item, b: Item) {
  return (
    cmp(Number(a.row.checked), Number(b.row.checked)) ||
    cmp(b.row.priority, a.row.priority) ||
    cmp(a.order, b.order) ||
    cmp(a.row.docId, b.row.docId) ||
    cmp(a.row.blockId, b.row.blockId)
  );
}

const compareDueThenInGroup = (a: Item, b: Item) =>
  cmp(Number(a.row.checked), Number(b.row.checked)) ||
  cmp(a.row.due ?? '', b.row.due ?? '') ||
  compareInGroup(a, b);

const compareDocNewestFirst = (a: Item, b: Item) =>
  cmp(Number(a.row.checked), Number(b.row.checked)) ||
  cmp(b.docCreatedAt, a.docCreatedAt) ||
  cmp(a.row.docId, b.row.docId) ||
  cmp(a.order, b.order) ||
  cmp(a.row.blockId, b.row.blockId);

function group(
  key: string,
  kind: TaskGroup['kind'],
  items: Item[],
  compare: (a: Item, b: Item) => number,
  extra: Partial<TaskGroup> = {}
): TaskGroup {
  return {
    key,
    kind,
    ...extra,
    rows: items.sort(compare).map(item => item.row),
  };
}

function groupBy<T>(items: T[], key: (item: T) => string) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    map.set(k, [...(map.get(k) ?? []), item]);
  }
  return map;
}

function byDay(items: Item[], includeOverdue: boolean) {
  const groups: TaskGroup[] = [];
  if (includeOverdue) {
    const overdue = items.filter(i => i.row.overdue);
    if (overdue.length) {
      groups.push(group('overdue', 'overdue', overdue, compareDueThenInGroup));
    }
  }
  const days = groupBy(
    items.filter(i => !i.row.overdue),
    i => i.row.due as string
  );
  for (const day of [...days.keys()].sort()) {
    groups.push(
      group(`day:${day}`, 'day', days.get(day) as Item[], compareInGroup, {
        date: day,
      })
    );
  }
  return groups;
}

export function buildView(
  view: TasksViewId,
  tasks: readonly IndexedTask[],
  docs: ReadonlyMap<string, DocInfo>,
  today: string,
  refTitles: ReadonlyMap<string, string> = new Map()
): TaskGroup[] {
  const items = buildItems(tasks, docs, today, refTitles);

  if (view === 'completed') {
    const days = groupBy(
      items.filter(i => i.row.checked),
      i => localDay(i.row.completedAt ?? 0)
    );
    return [...days.keys()]
      .sort()
      .reverse()
      .map(day =>
        group(
          `completed:${day}`,
          'completed-day',
          days.get(day) as Item[],
          (a, b) =>
            cmp(b.row.completedAt ?? 0, a.row.completedAt ?? 0) ||
            compareInGroup(a, b),
          { date: day }
        )
      );
  }

  const inView = items.filter(
    i => isVisibleInNormalViews(i.row, today) && isInView(view, i.row, today)
  );

  switch (view) {
    case 'inbox': {
      const perDoc = groupBy(inView, i => i.row.docId);
      return [...perDoc.values()]
        .sort(
          (a, b) =>
            cmp(b[0].docCreatedAt, a[0].docCreatedAt) ||
            cmp(a[0].row.docId, b[0].row.docId)
        )
        .map(docItems =>
          group(
            `doc:${docItems[0].row.docId}`,
            'doc',
            docItems,
            compareInGroup,
            {
              docId: docItems[0].row.docId,
              docTitle: docItems[0].row.docTitle,
            }
          )
        );
    }
    case 'today':
    case 'next7':
      return byDay(inView, true);
    case 'tomorrow':
      return byDay(inView, false);
    case 'all': {
      const scheduled = inView.filter(i => i.row.due !== null);
      const inbox = inView.filter(i => i.row.due === null);
      return [
        group('scheduled', 'scheduled', scheduled, compareDueThenInGroup),
        group('inbox', 'inbox', inbox, compareDocNewestFirst),
      ].filter(g => g.rows.length > 0);
    }
  }
}

export function buildCounts(
  tasks: readonly IndexedTask[],
  docs: ReadonlyMap<string, DocInfo>,
  today: string
): TasksCounts {
  // Counts don't use titles, so the empty refTitles map only affects them.
  const items = buildItems(tasks, docs, today, new Map());
  const count = (view: TasksViewId) =>
    items.filter(i => !i.row.checked && isInView(view, i.row, today)).length;
  const inbox = count('inbox');
  return {
    inbox,
    today: count('today'),
    tomorrow: count('tomorrow'),
    next7: count('next7'),
    all: count('all'),
    completed: items.filter(i => i.row.checked).length,
  };
}
