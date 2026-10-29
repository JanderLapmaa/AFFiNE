import { DatePicker } from '@affine/component';
import type { TaskPriority } from '@affine/core/modules/tasks';
import { useI18n } from '@affine/i18n';
import { useState } from 'react';

import { datePresets } from './triage';
import * as styles from './triage-editor.css';
import { useNow } from './use-now';

export interface TriageValue {
  due: string | null;
  priority: TaskPriority;
}

export interface TriagePartProps {
  due: string | null;
  priority: TaskPriority;
  onSetDue: (due: string | null) => void;
  onSetPriority: (priority: TaskPriority) => void;
}

const PRIORITY_OPTIONS = [
  [3, 'com.affine.tasks.triage.priority.high'],
  [2, 'com.affine.tasks.triage.priority.medium'],
  [1, 'com.affine.tasks.triage.priority.low'],
  [0, 'com.affine.tasks.triage.priority.none'],
] as const;

const PRESET_KEYS = {
  today: 'com.affine.tasks.date.today',
  tomorrow: 'com.affine.tasks.date.tomorrow',
  'next-monday': 'com.affine.tasks.triage.date.next-monday',
  'in-a-week': 'com.affine.tasks.triage.date.in-a-week',
} as const;

/** Date chips, a date picker and Clear. */
export const TriageDatePart = ({
  due,
  onSetDue,
  initialPickerOpen = false,
}: Pick<TriagePartProps, 'due' | 'onSetDue'> & {
  initialPickerOpen?: boolean;
}) => {
  const t = useI18n();
  const [pickerOpen, setPickerOpen] = useState(initialPickerOpen);
  // Presets are computed on render so they follow the day rolling over.
  const presets = datePresets(useNow());
  const isPreset = presets.some(p => p.date === due);
  return (
    <div className={styles.part} data-testid="tasks-triage-date">
      <div className={styles.label}>{t['com.affine.tasks.triage.date']()}</div>
      <div className={styles.chips}>
        {presets.map(preset => (
          <button
            key={preset.id}
            type="button"
            className={styles.chip}
            data-active={due === preset.date}
            data-testid={`tasks-date-${preset.id}`}
            onClick={() => onSetDue(preset.date)}
          >
            {t[PRESET_KEYS[preset.id]]()}
          </button>
        ))}
        <button
          type="button"
          className={styles.chip}
          data-active={!!due && !isPreset}
          data-testid="tasks-date-pick"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen(open => !open)}
        >
          {t['com.affine.tasks.triage.date.pick']()}
        </button>
        {due ? (
          <button
            type="button"
            className={styles.chip}
            data-testid="tasks-date-clear"
            onClick={() => onSetDue(null)}
          >
            {t['com.affine.tasks.triage.date.clear']()}
          </button>
        ) : null}
      </div>
      {pickerOpen ? (
        <div className={styles.picker} data-testid="tasks-date-picker">
          <DatePicker
            value={due ?? undefined}
            onChange={value => onSetDue(value)}
            weekDays={t['com.affine.calendar-date-picker.week-days']()}
            monthNames={t['com.affine.calendar-date-picker.month-names']()}
            todayLabel={t['com.affine.calendar-date-picker.today']()}
          />
        </div>
      ) : null}
    </div>
  );
};

/** High / Medium / Low / None. */
export const TriagePriorityPart = ({
  priority,
  onSetPriority,
}: Pick<TriagePartProps, 'priority' | 'onSetPriority'>) => {
  const t = useI18n();
  return (
    <div className={styles.part} data-testid="tasks-triage-priority">
      <div className={styles.label}>
        {t['com.affine.tasks.triage.priority']()}
      </div>
      <div className={styles.chips}>
        {PRIORITY_OPTIONS.map(([value, key]) => (
          <button
            key={value}
            type="button"
            className={styles.chip}
            data-active={priority === value}
            data-testid={`tasks-priority-${value}`}
            onClick={() => onSetPriority(value)}
          >
            <span className={styles.priorityDot} data-priority={value} />
            {t[key]()}
          </button>
        ))}
      </div>
    </div>
  );
};

/** The full editor: used in the detail panel. */
export const TriageEditor = ({
  due,
  priority,
  onSetDue,
  onSetPriority,
}: TriagePartProps) => (
  <div className={styles.editor} data-testid="tasks-triage-editor">
    <TriageDatePart due={due} onSetDue={onSetDue} />
    <TriagePriorityPart priority={priority} onSetPriority={onSetPriority} />
  </div>
);
