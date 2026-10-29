import { IconButton, Menu } from '@affine/component';
import {
  TriageDatePart,
  TriagePriorityPart,
} from '@affine/core/components/tasks/triage-editor';
import * as styles from '@affine/core/components/tasks/triage-editor.css';
import type { TaskPriority, TaskRow } from '@affine/core/modules/tasks';
import { useI18n } from '@affine/i18n';
import { CalendarPanelIcon, FlagPanelIcon } from '@blocksuite/icons/rc';
import { useState } from 'react';

export interface RowActionsProps {
  task: TaskRow;
  /** Controlled, so that `D` can open the date menu of the focused row. */
  dateMenuOpen: boolean;
  onDateMenuOpenChange: (open: boolean) => void;
  /** The date menu was opened with `D`: show the calendar straight away. */
  pickerFirst: boolean;
  onSetDue: (task: TaskRow, due: string | null) => void;
  onSetPriority: (task: TaskRow, priority: TaskPriority) => void;
  /** A menu closed: give focus back to the row. */
  onMenuClosed: (task: TaskRow) => void;
}

/** Inbox hover triage: a calendar button and a flag button, each a popover. */
export const RowActions = ({
  task,
  dateMenuOpen,
  onDateMenuOpenChange,
  pickerFirst,
  onSetDue,
  onSetPriority,
  onMenuClosed,
}: RowActionsProps) => {
  const t = useI18n();
  const [priorityOpen, setPriorityOpen] = useState(false);
  // Radix would focus the (tabindex -1) trigger button; keep keys working on the row.
  const onCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    onMenuClosed(task);
  };
  return (
    <>
      <Menu
        rootOptions={{
          open: dateMenuOpen,
          onOpenChange: onDateMenuOpenChange,
        }}
        contentOptions={{ align: 'end', onCloseAutoFocus }}
        items={
          <div className={styles.menuContent}>
            <TriageDatePart
              due={task.due}
              initialPickerOpen={pickerFirst}
              onSetDue={due => {
                onDateMenuOpenChange(false);
                onSetDue(task, due);
              }}
            />
          </div>
        }
      >
        <IconButton
          size="20"
          data-testid="tasks-row-set-date"
          title={t['com.affine.tasks.row.set-date']()}
          aria-label={t['com.affine.tasks.row.set-date']()}
          tabIndex={-1}
        >
          <CalendarPanelIcon />
        </IconButton>
      </Menu>
      <Menu
        rootOptions={{
          open: priorityOpen,
          onOpenChange: setPriorityOpen,
        }}
        contentOptions={{ align: 'end', onCloseAutoFocus }}
        items={
          <div className={styles.menuContentNarrow}>
            <TriagePriorityPart
              priority={task.priority}
              onSetPriority={priority => {
                setPriorityOpen(false);
                onSetPriority(task, priority);
              }}
            />
          </div>
        }
      >
        <IconButton
          size="20"
          data-testid="tasks-row-set-priority"
          title={t['com.affine.tasks.row.set-priority']()}
          aria-label={t['com.affine.tasks.row.set-priority']()}
          tabIndex={-1}
        >
          <FlagPanelIcon />
        </IconButton>
      </Menu>
    </>
  );
};
