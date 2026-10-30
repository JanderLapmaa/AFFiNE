import type { Observable } from 'rxjs';

import type { IndexedTask } from '../projection';
import type { TaskPriority, TasksState } from '../types';

/** The values of a todo block that the Tasks view reads and writes. */
export interface TaskValues {
  due: string | null;
  priority: TaskPriority;
  checked: boolean;
  completedAt: number | null;
}

export type Patch = Partial<TaskValues>;

/**
 * Where the task rows come from. The service shapes them into views the same
 * way for every source; a source owns finding the rows, keeping them fresh and
 * making its own writes show at once.
 */
export interface TaskSource {
  /** Where the rows come from. */
  readonly kind: 'local' | 'cloud';
  /** Every todo row (not yet filtered by doc state). Never clears on reload. */
  readonly rows$: Observable<IndexedTask[]>;
  readonly state$: Observable<TasksState>;
  /** Re-runs the query after an error (or on demand). */
  retry(): void;
  /**
   * Writes `decide(the task's current values)` and resolves with the previous
   * values of what it changed (for undo). Rejects when the task can't be
   * written. The service runs writes one at a time.
   */
  apply(id: string, decide: (before: TaskValues) => Patch): Promise<Patch>;
  dispose(): void;
}
