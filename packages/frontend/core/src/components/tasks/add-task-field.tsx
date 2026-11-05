import {
  localDay,
  parseQuickAdd,
  type TasksViewId,
} from '@affine/core/modules/tasks';
import { useI18n } from '@affine/i18n';
import { PlusIcon } from '@blocksuite/icons/rc';
import { type KeyboardEvent, useCallback, useMemo, useState } from 'react';

import * as styles from './add-task-field.css';
import { QuickAddPreview } from './quick-add-preview';
import { useNow } from './use-now';
import { useTaskActions } from './use-task-actions';

/**
 * `+ Add task` at the top of a view (story 49). Enter adds the task to the
 * Tasks doc; date and priority tokens (`@tomorrow !high`) are read from the
 * text, and the Today and Tomorrow views give their date to a task without a
 * date token.
 */
export const AddTaskField = ({ view }: { view: TasksViewId }) => {
  const t = useI18n();
  const now = useNow();
  const { quickAdd } = useTaskActions();
  const [text, setText] = useState('');
  const parsed = useMemo(() => parseQuickAdd(text, localDay(now)), [now, text]);

  const submit = useCallback(async () => {
    const value = text;
    if (!parsed.text) return;
    // Cleared at once so the next task can be typed; put back on failure.
    setText('');
    if (!(await quickAdd(value, view))) {
      setText(current => current || value);
    }
  }, [parsed.text, quickAdd, text, view]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
        event.preventDefault();
        submit().catch(console.error);
      } else if (event.key === 'Escape') {
        setText('');
        event.currentTarget.blur();
      }
    },
    [submit]
  );

  return (
    <div className={styles.root} data-testid="tasks-add">
      <label className={styles.field}>
        <PlusIcon />
        <input
          className={styles.input}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t['com.affine.tasks.add.placeholder']()}
          aria-label={t['com.affine.tasks.add.label']()}
          data-testid="tasks-add-input"
          enterKeyHint="done"
        />
      </label>
      <QuickAddPreview parsed={parsed} now={now} />
    </div>
  );
};
