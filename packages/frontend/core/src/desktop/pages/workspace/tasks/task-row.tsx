import { Checkbox } from '@affine/component';
import type { TaskRow } from '@affine/core/modules/tasks';
import { useI18n } from '@affine/i18n';
import { FlagPanelIcon, PageIcon } from '@blocksuite/icons/rc';
import clsx from 'clsx';
import {
  type FocusEvent,
  forwardRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useId,
} from 'react';

import { rowDateLabel } from './format';
import * as styles from './task-row.css';
import { useLocale, useNow } from './use-now';

export interface TaskRowItemProps {
  task: TaskRow;
  /** Completed view: shows the original due date instead of the overdue label. */
  completedView?: boolean;
  /** Roving tabindex: 0 for the one focusable row of the list, -1 otherwise. */
  tabIndex?: number;
  onFocus?: (event: FocusEvent<HTMLDivElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** Row click or Enter. Phase 4b: opens the detail panel. */
  onOpen?: (task: TaskRow) => void;
  onToggle: (task: TaskRow) => void;
  /** Source line click: open the doc scrolled to the block. */
  onOpenSource: (task: TaskRow, event: MouseEvent) => void;
  /**
   * Trailing hover actions (phase 4b: Inbox triage buttons). Shown on hover
   * and keyboard focus, replacing the date and priority flag.
   */
  actions?: ReactNode;
}

const PRIORITY_KEYS = [
  null,
  'com.affine.tasks.priority.low',
  'com.affine.tasks.priority.medium',
  'com.affine.tasks.priority.high',
] as const;

export const TaskRowItem = forwardRef<HTMLDivElement, TaskRowItemProps>(
  (
    {
      task,
      completedView = false,
      tabIndex = -1,
      onFocus,
      onKeyDown,
      onOpen,
      onToggle,
      onOpenSource,
      actions,
    },
    ref
  ) => {
    const t = useI18n();
    const now = useNow();
    const locale = useLocale();
    const titleId = useId();
    const date = rowDateLabel(task, completedView, t, now, locale);
    const priorityKey = PRIORITY_KEYS[task.priority];

    const handleClick = useCallback(() => onOpen?.(task), [onOpen, task]);
    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(event);
        if (
          !event.defaultPrevented &&
          event.key === 'Enter' &&
          event.target === event.currentTarget
        ) {
          onOpen?.(task);
        }
      },
      [onKeyDown, onOpen, task]
    );
    const stop = useCallback(
      (event: MouseEvent) => event.stopPropagation(),
      []
    );
    const handleToggle = useCallback(() => onToggle(task), [onToggle, task]);
    const handleSource = useCallback(
      (event: MouseEvent) => {
        event.stopPropagation();
        onOpenSource(task, event);
      },
      [onOpenSource, task]
    );

    return (
      <div
        ref={ref}
        className={styles.row}
        role="listitem"
        tabIndex={tabIndex}
        data-testid="tasks-row"
        data-task-id={task.id}
        data-checked={task.checked}
        data-has-actions={!!actions}
        onClick={handleClick}
        onFocus={onFocus}
        onKeyDown={handleKeyDown}
      >
        <span className={styles.checkboxWrapper} onClick={stop}>
          <Checkbox
            className={styles.checkbox}
            data-priority={task.priority}
            checked={task.checked}
            onChange={handleToggle}
            aria-labelledby={titleId}
          />
        </span>
        <div className={styles.body}>
          <div
            id={titleId}
            className={styles.title}
            data-checked={task.checked}
          >
            {task.title}
          </div>
          <button
            type="button"
            className={styles.source}
            tabIndex={-1}
            title={t['com.affine.tasks.row.open-source']()}
            onClick={handleSource}
          >
            <PageIcon className={styles.sourceIcon} />
            <span className={styles.sourceText}>
              {task.heading
                ? `${task.docTitle} › ${task.heading}`
                : task.docTitle}
            </span>
          </button>
        </div>
        <div className={styles.trailing}>
          <div className={styles.meta}>
            {date ? (
              <span className={clsx(date.overdue && styles.overdue)}>
                {date.text}
              </span>
            ) : null}
            {priorityKey ? (
              <FlagPanelIcon
                className={styles.flag}
                data-priority={task.priority}
                aria-label={t[priorityKey]()}
              />
            ) : null}
          </div>
          {actions ? (
            <div className={styles.actions} onClick={stop}>
              {actions}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
);
TaskRowItem.displayName = 'TaskRowItem';
