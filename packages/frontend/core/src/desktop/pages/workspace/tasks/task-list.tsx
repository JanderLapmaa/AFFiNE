import { Button, Skeleton } from '@affine/component';
import type {
  TaskGroup,
  TaskRow,
  TasksState,
  TasksViewId,
} from '@affine/core/modules/tasks';
import { useI18n } from '@affine/i18n';
import {
  CalendarPanelIcon,
  DoneIcon,
  InboxIcon,
  PageIcon,
  TodayIcon,
  ToggleDownIcon,
  ToggleRightIcon,
} from '@blocksuite/icons/rc';
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { groupLabel } from './format';
import * as styles from './task-list.css';
import { TaskRowItem } from './task-row';
import { useCollapsedGroups } from './use-collapsed-groups';
import { useLocale, useNow } from './use-now';

export const VIEW_ICONS: Record<TasksViewId, ReactNode> = {
  inbox: <InboxIcon />,
  today: <TodayIcon />,
  tomorrow: <CalendarPanelIcon />,
  next7: <CalendarPanelIcon />,
  all: <DoneIcon />,
  completed: <DoneIcon />,
};

const EMPTY_KEYS = {
  inbox: [
    'com.affine.tasks.empty.inbox.title',
    'com.affine.tasks.empty.inbox.description',
  ],
  today: [
    'com.affine.tasks.empty.today.title',
    'com.affine.tasks.empty.today.description',
  ],
  tomorrow: [
    'com.affine.tasks.empty.tomorrow.title',
    'com.affine.tasks.empty.tomorrow.description',
  ],
  next7: [
    'com.affine.tasks.empty.next7.title',
    'com.affine.tasks.empty.next7.description',
  ],
  all: [
    'com.affine.tasks.empty.all.title',
    'com.affine.tasks.empty.all.description',
  ],
  completed: [
    'com.affine.tasks.empty.completed.title',
    'com.affine.tasks.empty.completed.description',
  ],
} as const;

const SKELETON_GROUPS = [0, 1, 2];
const SKELETON_ROWS = [0, 1, 2];

const TasksSkeleton = () => (
  <div data-testid="tasks-skeleton" aria-busy="true">
    {SKELETON_GROUPS.map(g => (
      <div key={g} className={styles.group}>
        <Skeleton variant="text" width={120} height={16} />
        {SKELETON_ROWS.map(r => (
          <div key={r} className={styles.skeletonRow}>
            <Skeleton variant="rounded" width={18} height={18} />
            <div className={styles.skeletonText}>
              <Skeleton variant="text" width={`${70 - r * 12}%`} height={16} />
              <Skeleton variant="text" width="30%" height={12} />
            </div>
          </div>
        ))}
      </div>
    ))}
  </div>
);

const ErrorBanner = ({ onRetry }: { onRetry: () => void }) => {
  const t = useI18n();
  return (
    <div className={styles.errorBanner} role="alert" data-testid="tasks-error">
      <span className={styles.errorText}>
        {t['com.affine.tasks.error.title']()}
      </span>
      <Button size="default" onClick={onRetry}>
        {t['com.affine.tasks.error.retry']()}
      </Button>
    </div>
  );
};

const EmptyState = ({
  view,
  onGoToInbox,
}: {
  view: TasksViewId;
  onGoToInbox: () => void;
}) => {
  const t = useI18n();
  const [title, description] = EMPTY_KEYS[view];
  const pointsToInbox =
    view === 'today' || view === 'tomorrow' || view === 'next7';
  return (
    <div className={styles.empty} data-testid="tasks-empty">
      <div className={styles.emptyIcon}>{VIEW_ICONS[view]}</div>
      <h3 className={styles.emptyTitle}>{t[title]()}</h3>
      <p className={styles.emptyDescription}>{t[description]()}</p>
      {pointsToInbox ? (
        <Button onClick={onGoToInbox}>
          {t['com.affine.tasks.empty.go-to-inbox']()}
        </Button>
      ) : null}
    </div>
  );
};

export interface TaskListProps {
  view: TasksViewId;
  groups: TaskGroup[];
  state: TasksState;
  onRetry: () => void;
  onGoToInbox: () => void;
  onToggle: (task: TaskRow) => void;
  onOpenSource: (task: TaskRow, event: MouseEvent) => void;
  /** Phase 4b: row click opens the detail panel. */
  onOpenTask?: (task: TaskRow) => void;
  /** Phase 4b: trailing hover actions per row (Inbox triage buttons). */
  renderRowActions?: (task: TaskRow, group: TaskGroup) => ReactNode;
  /**
   * Phase 4b: keyboard triage. Called for every key pressed while a row
   * itself has focus (not its checkbox or links). Call `preventDefault()` to
   * stop the built-in arrow, Home and End navigation.
   */
  onRowKeyDown?: (event: KeyboardEvent<HTMLElement>, task: TaskRow) => void;
}

/**
 * Grouped task list with a roving tabindex: exactly one row is in the tab
 * order, arrow keys move between visible rows (collapsed groups are skipped).
 */
export const TaskList = ({
  view,
  groups,
  state,
  onRetry,
  onGoToInbox,
  onToggle,
  onOpenSource,
  onOpenTask,
  renderRowActions,
  onRowKeyDown,
}: TaskListProps) => {
  const t = useI18n();
  const now = useNow();
  const locale = useLocale();
  const { isCollapsed, toggle } = useCollapsedGroups(view);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const [activeId, setActiveId] = useState<string | null>(null);

  const visibleRows = useMemo(
    () => groups.filter(g => !isCollapsed(g.key)).flatMap(g => g.rows),
    [groups, isCollapsed]
  );
  const focusableId = visibleRows.some(r => r.id === activeId)
    ? activeId
    : (visibleRows[0]?.id ?? null);

  // When the focused row leaves the list (triage moved it to another view),
  // focus falls to <body>: hand it to the row that took its place so the
  // keyboard flow carries on.
  const lastIndexRef = useRef(-1);
  useEffect(() => {
    const index = visibleRows.findIndex(r => r.id === activeId);
    if (index >= 0) {
      lastIndexRef.current = index;
      return;
    }
    if (!activeId || lastIndexRef.current < 0) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const next =
      visibleRows[Math.min(lastIndexRef.current, visibleRows.length - 1)];
    if (next) {
      setActiveId(next.id);
      rowRefs.current.get(next.id)?.focus();
    }
  }, [visibleRows, activeId]);

  const handleFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    setActiveId(event.currentTarget.dataset.taskId ?? null);
  }, []);

  const focusRow = useCallback((id: string | undefined) => {
    if (!id) return;
    setActiveId(id);
    rowRefs.current.get(id)?.focus();
  }, []);

  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, task: TaskRow) => {
      if (event.target !== event.currentTarget) return;
      onRowKeyDown?.(event, task);
      if (event.defaultPrevented) return;
      const index = visibleRows.findIndex(r => r.id === task.id);
      let next: number | null = null;
      if (event.key === 'ArrowDown')
        next = Math.min(index + 1, visibleRows.length - 1);
      else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = visibleRows.length - 1;
      if (next === null) return;
      event.preventDefault();
      focusRow(visibleRows[next]?.id);
    },
    [focusRow, onRowKeyDown, visibleRows]
  );

  const setRowRef = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) rowRefs.current.set(id, el);
      else rowRefs.current.delete(id);
    },
    []
  );

  const hasGroups = groups.length > 0;
  const loading = state.status === 'loading' && !hasGroups;
  const failed = state.status === 'error';
  const showEmpty = !hasGroups && state.status === 'ready';

  return (
    <div className={styles.list} data-testid="tasks-list">
      {failed ? <ErrorBanner onRetry={onRetry} /> : null}
      {loading ? <TasksSkeleton /> : null}
      {showEmpty ? <EmptyState view={view} onGoToInbox={onGoToInbox} /> : null}
      {groups.map(group => {
        const collapsed = isCollapsed(group.key);
        return (
          <section
            key={group.key}
            className={styles.group}
            data-testid="tasks-group"
            data-collapsed={collapsed}
          >
            <button
              type="button"
              className={styles.groupHeader}
              data-overdue={group.kind === 'overdue'}
              aria-expanded={!collapsed}
              onClick={() => toggle(group.key)}
            >
              {collapsed ? <ToggleRightIcon /> : <ToggleDownIcon />}
              {group.kind === 'doc' ? <PageIcon /> : null}
              <span className={styles.groupTitle}>
                {groupLabel(group, t, now, locale)}
              </span>
              <span className={styles.groupCount}>{group.rows.length}</span>
            </button>
            {collapsed ? null : (
              <div role="list">
                {group.rows.map(task => (
                  <TaskRowItem
                    key={task.id}
                    ref={setRowRef(task.id)}
                    task={task}
                    completedView={view === 'completed'}
                    tabIndex={task.id === focusableId ? 0 : -1}
                    onFocus={handleFocus}
                    onKeyDown={e => handleRowKeyDown(e, task)}
                    onOpen={onOpenTask}
                    onToggle={onToggle}
                    onOpenSource={onOpenSource}
                    actions={renderRowActions?.(task, group)}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
};
