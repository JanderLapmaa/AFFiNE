import type { TaskGroup, TaskRow } from '@affine/core/modules/tasks';
import { addDays, localDay } from '@affine/core/modules/tasks';
import { i18nTime, type useI18n } from '@affine/i18n';

type I18n = ReturnType<typeof useI18n>;

/** `Fri 30 Oct` (English), the locale's own order elsewhere. */
export function shortDay(day: string, locale: string) {
  const date = parseDay(day);
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  };
  if (!locale.startsWith('en')) {
    return new Intl.DateTimeFormat(locale, options).format(date);
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    new Intl.DateTimeFormat('en', options)
      .formatToParts(date)
      .find(p => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')}`;
}

/** `Tuesday, Oct 27` (English). */
export function longDay(day: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(parseDay(day));
}

const parseDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** `Today`, `Tomorrow`, `Fri 30 Oct`, or `2d ago` (i18nTime, narrow) for days in the past. */
export function dueLabel(
  due: string,
  t: I18n,
  { relativePast = true }: { relativePast?: boolean } = {},
  now = Date.now(),
  locale = 'en'
) {
  const today = localDay(now);
  if (due === today) return t['com.affine.tasks.date.today']();
  if (due === addDays(today, 1)) return t['com.affine.tasks.date.tomorrow']();
  if (relativePast && due < today) {
    return i18nTime(due, {
      now,
      relative: { accuracy: 'day', yesterdayAndTomorrow: false },
    });
  }
  return shortDay(due, locale);
}

/** Date text of a row: relative for overdue tasks, `Due …` in Completed. */
export function rowDateLabel(
  task: TaskRow,
  completedView: boolean,
  t: I18n,
  now = Date.now(),
  locale = 'en'
): { text: string; overdue: boolean } | null {
  if (!task.due) return null;
  if (completedView) {
    return {
      text: t['com.affine.tasks.date.due']({
        date: dueLabel(task.due, t, { relativePast: false }, now, locale),
      }),
      overdue: false,
    };
  }
  return {
    text: dueLabel(task.due, t, undefined, now, locale),
    overdue: task.overdue,
  };
}

export function groupLabel(
  group: TaskGroup,
  t: I18n,
  now = Date.now(),
  locale = 'en'
) {
  const today = localDay(now);
  switch (group.kind) {
    case 'overdue':
      return t['com.affine.tasks.group.overdue']();
    case 'day': {
      const day = group.date ?? today;
      if (day === today) return t['com.affine.tasks.date.today']();
      if (day === addDays(today, 1)) {
        return t['com.affine.tasks.date.tomorrow']();
      }
      return longDay(day, locale);
    }
    case 'doc':
      return group.docTitle || t['com.affine.tasks.group.untitled-doc']();
    case 'scheduled':
      return t['com.affine.tasks.group.scheduled']();
    case 'inbox':
      return t['com.affine.tasks.group.inbox']();
    case 'completed-day': {
      const day = group.date ?? today;
      if (day === today) return t['com.affine.tasks.group.completed-today']();
      return t['com.affine.tasks.group.completed-day']({
        date: longDay(day, locale),
      });
    }
  }
}
