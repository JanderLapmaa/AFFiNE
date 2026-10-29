import { Button, IconButton } from '@affine/component';
import {
  localDay,
  type TaskGroup,
  type TaskPriority,
  type TaskRow,
  TasksService,
} from '@affine/core/modules/tasks';
import { useI18n } from '@affine/i18n';
import { CloseIcon, PageIcon } from '@blocksuite/icons/rc';
import { useLiveData, useService } from '@toeverything/infra';
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useMemo,
} from 'react';

import * as styles from './detail-panel.css';
import { longDay } from './format';
import { TriageEditor } from './triage-editor';
import { useLocale, useNow } from './use-now';

export interface TaskDetailProps {
  /** Null: nothing selected, or the selected task no longer exists. */
  task: TaskRow | null;
  onClose: () => void;
  onSetDue: (task: TaskRow, due: string | null) => void;
  onSetPriority: (task: TaskRow, priority: TaskPriority) => void;
  onOpenSource: (task: TaskRow, event: MouseEvent) => void;
}

/** Right panel content: title (read-only), triage editor and source box. */
export const TaskDetail = ({
  task,
  onClose,
  onSetDue,
  onSetPriority,
  onOpenSource,
}: TaskDetailProps) => {
  const t = useI18n();
  const now = useNow();
  const locale = useLocale();
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.stopPropagation();
        onClose();
      }
    },
    [onClose]
  );

  if (!task) {
    return (
      <div className={styles.empty} data-testid="tasks-detail-empty">
        {t['com.affine.tasks.detail.empty']()}
      </div>
    );
  }

  return (
    <div
      className={styles.panel}
      data-testid="tasks-detail"
      onKeyDown={handleKeyDown}
    >
      <div className={styles.header}>
        <span>{t['com.affine.tasks.detail.title']()}</span>
        <IconButton
          size="20"
          data-testid="tasks-detail-close"
          aria-label={t['com.affine.tasks.detail.close']()}
          title={t['com.affine.tasks.detail.close']()}
          onClick={onClose}
        >
          <CloseIcon />
        </IconButton>
      </div>
      <div
        className={styles.title}
        data-checked={task.checked}
        data-testid="tasks-detail-title"
      >
        {task.title}
      </div>
      <TriageEditor
        due={task.due}
        priority={task.priority}
        onSetDue={due => onSetDue(task, due)}
        onSetPriority={priority => onSetPriority(task, priority)}
      />
      {task.checked && task.completedAt !== null ? (
        <div
          className={styles.completedLine}
          data-testid="tasks-detail-completed"
        >
          {completedLabel(task.completedAt, now, locale, t)}
        </div>
      ) : null}
      <div className={styles.source} data-testid="tasks-detail-source">
        <div className={styles.sourceLabel}>
          {t['com.affine.tasks.detail.source']()}
        </div>
        {task.quickAdd ? (
          <div className={styles.sourceDoc}>
            {t['com.affine.tasks.row.quick-add']()}
          </div>
        ) : (
          <>
            <div className={styles.sourceDoc}>
              <PageIcon />
              <span className={styles.sourceText}>
                {task.heading
                  ? `${task.docTitle} › ${task.heading}`
                  : task.docTitle}
              </span>
            </div>
            <Button
              data-testid="tasks-detail-open-source"
              onClick={event => onOpenSource(task, event)}
            >
              {t['com.affine.tasks.row.open-source']()}
            </Button>
          </>
        )}
      </div>
    </div>
  );
};

const completedLabel = (
  completedAt: number,
  now: number,
  locale: string,
  t: ReturnType<typeof useI18n>
) => {
  const day = localDay(completedAt);
  return day === localDay(now)
    ? t['com.affine.tasks.group.completed-today']()
    : t['com.affine.tasks.group.completed-day']({ date: longDay(day, locale) });
};

const findTask = (groups: TaskGroup[], id: string) => {
  for (const group of groups) {
    const row = group.rows.find(r => r.id === id);
    if (row) return row;
  }
  return null;
};

/** Looks the task up by id in All tasks / Completed, so the panel follows it across views. */
const SelectedDetail = ({
  selectedId,
  ...props
}: Omit<TaskDetailProps, 'task'> & { selectedId: string }) => {
  const tasksService = useService(TasksService);
  const allGroups = useLiveData(tasksService.view$('all'));
  const completedGroups = useLiveData(tasksService.view$('completed'));
  const task = useMemo(
    () =>
      findTask(allGroups, selectedId) ?? findTask(completedGroups, selectedId),
    [allGroups, completedGroups, selectedId]
  );
  return <TaskDetail task={task} {...props} />;
};

/** Subscribes to the task lists only while a task is selected. */
export const TaskDetailContainer = ({
  selectedId,
  ...props
}: Omit<TaskDetailProps, 'task'> & { selectedId: string | null }) =>
  selectedId ? (
    <SelectedDetail selectedId={selectedId} {...props} />
  ) : (
    <TaskDetail task={null} {...props} />
  );
