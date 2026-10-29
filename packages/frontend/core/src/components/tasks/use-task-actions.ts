import { notify } from '@affine/component';
import {
  type TaskPriority,
  type TaskRow,
  TasksService,
  type TasksUndo,
} from '@affine/core/modules/tasks';
import { useI18n } from '@affine/i18n';
import { useService } from '@toeverything/infra';
import { useCallback, useMemo } from 'react';

import { dueLabel } from './format';
import { isInbox } from './triage';
import { useLocale } from './use-now';

const fire = (promise: Promise<unknown>) => {
  promise.catch(console.error);
};

/** Only the latest change can be undone, so only its toast stays. */
let lastUndoToast: string | number | undefined;

/** How long the Undo toast stays. */
export const UNDO_TOAST_MS = 5000;

const PRIORITY_NAMES = [
  null,
  'com.affine.tasks.triage.priority.low',
  'com.affine.tasks.triage.priority.medium',
  'com.affine.tasks.triage.priority.high',
] as const;

/**
 * Triage and toggle writes of the Tasks view. Each one shows a toast with
 * Undo (stories 18 and 43), or an error toast when the write is rejected
 * (trashed or missing doc).
 */
export function useTaskActions() {
  const t = useI18n();
  const tasksService = useService(TasksService);
  const locale = useLocale();

  const run = useCallback(
    async (
      write: () => Promise<TasksUndo>,
      message: string,
      leftInbox = false
    ) => {
      // The old Undo must not outlive the start of a newer write.
      notify.dismiss(lastUndoToast);
      try {
        const undo = await write();
        lastUndoToast = notify.success(
          {
            title: leftInbox
              ? t['com.affine.tasks.toast.left-inbox']({ message })
              : message,
            actions: [
              {
                key: 'tasks-undo',
                label: t['com.affine.tasks.toast.undo'](),
                onClick: async () => {
                  try {
                    await undo();
                  } catch (error) {
                    console.error(error);
                    notify.error({
                      title: t['com.affine.tasks.toast.undo-error'](),
                    });
                  }
                },
              },
            ],
          },
          { duration: UNDO_TOAST_MS }
        );
      } catch (error) {
        console.error(error);
        notify.error({ title: t['com.affine.tasks.toast.error']() });
      }
    },
    [t]
  );

  return useMemo(
    () => ({
      setDue: (task: TaskRow, due: string | null) => {
        fire(
          run(
            () => tasksService.setDue(task.id, due),
            due
              ? t['com.affine.tasks.toast.scheduled']({
                  date: dueLabel(
                    due,
                    t,
                    { relativePast: false },
                    tasksService.now(),
                    locale
                  ),
                })
              : t['com.affine.tasks.toast.date-cleared'](),
            isInbox(task) && due !== null
          )
        );
      },
      setPriority: (task: TaskRow, priority: TaskPriority) => {
        const key = PRIORITY_NAMES[priority];
        fire(
          run(
            () => tasksService.setPriority(task.id, priority),
            key
              ? t['com.affine.tasks.toast.priority']({ priority: t[key]() })
              : t['com.affine.tasks.toast.priority-cleared']()
          )
        );
      },
      toggle: (task: TaskRow) => {
        fire(
          run(
            () => tasksService.toggle(task.id),
            task.checked
              ? t['com.affine.tasks.toast.reopened']()
              : t['com.affine.tasks.toast.completed']()
          )
        );
      },
    }),
    [locale, run, t, tasksService]
  );
}
