import type { TaskPriority, TaskRow } from '@affine/core/modules/tasks';
import { addDays, localDay } from '@affine/core/modules/tasks';
import type { KeyboardEvent } from 'react';

export type DatePresetId = 'today' | 'tomorrow' | 'next-monday' | 'in-a-week';

export interface DatePreset {
  id: DatePresetId;
  date: string;
}

/** First Monday strictly after `today` (a Monday gives the one 7 days on). */
export function nextMonday(today: string): string {
  const [y, m, d] = today.split('-').map(Number);
  const weekday = new Date(y, m - 1, d).getDay();
  return addDays(today, (8 - weekday) % 7 || 7);
}

export function datePresets(now = Date.now()): DatePreset[] {
  const today = localDay(now);
  return [
    { id: 'today', date: today },
    { id: 'tomorrow', date: addDays(today, 1) },
    { id: 'next-monday', date: nextMonday(today) },
    { id: 'in-a-week', date: addDays(today, 7) },
  ];
}

/** Open task without a date (a priority alone keeps it in the Inbox). */
export function isInbox(task: Pick<TaskRow, 'due' | 'checked'>) {
  return !task.checked && !task.due;
}

export type RowShortcut =
  | { type: 'due'; offset: 0 | 1 }
  | { type: 'pick-date' }
  | { type: 'priority'; priority: TaskPriority }
  | { type: 'toggle' }
  | { type: 'open' };

/**
 * Maps a key press on a focused row to a triage action. Returns null for
 * anything else, for modified keys (app shortcuts use modifiers) and for
 * keys typed into a field.
 */
export function rowShortcut(
  event: Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'target'
  > & { currentTarget: EventTarget }
): RowShortcut | null {
  if (event.target !== event.currentTarget) return null;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return null;
  }
  if (event.repeat) return null;
  switch (event.key) {
    case 't':
    case 'T':
      return { type: 'due', offset: 0 };
    case 'm':
    case 'M':
      return { type: 'due', offset: 1 };
    case 'd':
    case 'D':
      return { type: 'pick-date' };
    case '1':
      return { type: 'priority', priority: 1 };
    case '2':
      return { type: 'priority', priority: 2 };
    case '3':
      return { type: 'priority', priority: 3 };
    case ' ':
      return { type: 'toggle' };
    case 'Enter':
      return { type: 'open' };
    default:
      return null;
  }
}
