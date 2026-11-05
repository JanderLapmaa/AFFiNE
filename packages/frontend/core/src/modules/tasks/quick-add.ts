import { addDays } from './date';
import type { TaskPriority } from './types';

export interface ParsedQuickAdd {
  /** The text with the recognised tokens removed. */
  text: string;
  /** `YYYY-MM-DD` from a date token. */
  due?: string;
  /** From a priority token. */
  priority?: TaskPriority;
}

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const PRIORITIES: Record<string, TaskPriority> = {
  '1': 1,
  low: 1,
  '2': 2,
  med: 2,
  medium: 2,
  '3': 3,
  high: 3,
};

const weekdayOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
};

/** A real calendar day `YYYY-MM-DD` (rejects 2026-02-31). */
function isCalendarDay(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [y, m, d] = match.slice(1).map(Number);
  const date = new Date(y, m - 1, d);
  return (
    date.getFullYear() === y &&
    date.getMonth() === m - 1 &&
    date.getDate() === d
  );
}

/** The day a date token (without `@`) names, or null. */
function parseDateToken(token: string, today: string): string | null {
  if (token === 'today') return today;
  if (token === 'tomorrow' || token === 'tmr') return addDays(today, 1);
  if (token === 'nextweek') {
    // Monday of next week (a Monday gives the one 7 days on).
    return addDays(today, (8 - weekdayOf(today)) % 7 || 7);
  }
  const weekday = WEEKDAYS[token];
  if (weekday !== undefined) {
    // The nearest such day, today included.
    return addDays(today, (weekday - weekdayOf(today) + 7) % 7);
  }
  const offset = /^\+(\d{1,3})d$/.exec(token);
  if (offset) return addDays(today, Number(offset[1]));
  if (isCalendarDay(token)) return token;
  return null;
}

/**
 * Reads the date and priority tokens of a quick-add line, for example
 * `Call bank @tomorrow !high`. Date tokens: `@today`, `@tomorrow`, weekday
 * names (`@fri`, `@friday`), `@nextweek`, `@+3d` and `@YYYY-MM-DD`. Priority
 * tokens: `!1`-`!3` and `!low` / `!med` / `!high`. Tokens are whole words,
 * case-insensitive; the last one of a kind wins. Anything else, such as an
 * unknown `@word`, stays in the text.
 */
export function parseQuickAdd(input: string, today: string): ParsedQuickAdd {
  const result: ParsedQuickAdd = { text: '' };
  const words: string[] = [];
  for (const word of input.trim().split(/\s+/)) {
    if (!word) continue;
    const lower = word.toLowerCase();
    if (lower.length > 1 && lower.startsWith('@')) {
      const due = parseDateToken(lower.slice(1), today);
      if (due) {
        result.due = due;
        continue;
      }
    } else if (lower.length > 1 && lower.startsWith('!')) {
      const priority = PRIORITIES[lower.slice(1)];
      if (priority) {
        result.priority = priority;
        continue;
      }
    }
    words.push(word);
  }
  result.text = words.join(' ');
  return result;
}
