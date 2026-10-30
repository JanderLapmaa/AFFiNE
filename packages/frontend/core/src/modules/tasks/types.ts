/** Priority as stored on the block: 0 (or absent) none, 1 low, 2 medium, 3 high. */
export type TaskPriority = 0 | 1 | 2 | 3;

export type TasksViewId =
  | 'inbox'
  | 'today'
  | 'tomorrow'
  | 'next7'
  | 'all'
  | 'completed';

export type TaskGroupKind =
  /** Open tasks whose due date has passed (Today, Next 7 Days). */
  | 'overdue'
  /** Tasks due on `date`. */
  | 'day'
  /** Inbox tasks of one source doc (`docId`). */
  | 'doc'
  /** All tasks: tasks that have a due date. */
  | 'scheduled'
  /** All tasks: no due date. */
  | 'inbox'
  /** Completed view: tasks completed on `date`. */
  | 'completed-day';

export interface TaskRow {
  /** `docId:blockId` */
  id: string;
  docId: string;
  blockId: string;
  /** The block's text, with each linked-doc reference shown as that doc's title. */
  title: string;
  /** `YYYY-MM-DD` local calendar day */
  due: string | null;
  priority: TaskPriority;
  checked: boolean;
  /**
   * Effective completion time (epoch ms). Only set when `checked`: the
   * block's `completedAt`, else the source doc's last-updated time.
   */
  completedAt: number | null;
  docTitle: string;
  /** Nearest heading above the block, if any. */
  heading: string | null;
  /** Open (unchecked) and due before today. Never true for checked tasks. */
  overdue: boolean;
  /** The last write to this task failed (cloud workspaces); the row shows the old values. */
  error?: string;
}

export interface TaskGroup {
  /** Stable per view and group, usable as a collapse-state key. */
  key: string;
  kind: TaskGroupKind;
  /** `day` and `completed-day` groups: `YYYY-MM-DD` */
  date?: string;
  /** `doc` groups */
  docId?: string;
  /** `doc` groups */
  docTitle?: string;
  rows: TaskRow[];
}

/**
 * Unchecked tasks per view. `completed` is the exception: it is the number
 * of checked tasks.
 */
export type TasksCounts = Record<TasksViewId, number>;

/** Resolved by a write; calling it writes the previous values back. */
export type TasksUndo = () => Promise<void>;

export interface TasksState {
  status: 'loading' | 'ready' | 'error';
  message?: string;
}

export interface TasksClock {
  /** Epoch ms */
  now(): number;
}
