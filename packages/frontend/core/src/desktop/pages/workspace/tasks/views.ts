import type { TasksViewId } from '@affine/core/modules/tasks';

export const DEFAULT_VIEW: TasksViewId = 'today';

/** Nav order; the divider goes after the first four. */
export const NAV_VIEWS: readonly TasksViewId[] = [
  'inbox',
  'today',
  'tomorrow',
  'next7',
  'all',
  'completed',
];
export const NAV_DIVIDER_AFTER: TasksViewId = 'next7';

export function parseView(value: string | null): TasksViewId {
  return NAV_VIEWS.find(v => v === value) ?? DEFAULT_VIEW;
}

export function viewHref(view: TasksViewId) {
  return view === DEFAULT_VIEW ? '/tasks' : `/tasks?view=${view}`;
}
