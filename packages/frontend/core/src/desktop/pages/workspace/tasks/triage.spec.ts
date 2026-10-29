import { describe, expect, test } from 'vitest';

import { datePresets, nextMonday, rowShortcut } from './triage';

describe('nextMonday', () => {
  test('is strictly after today', () => {
    expect(nextMonday('2026-10-26')).toBe('2026-11-02'); // Monday
    expect(nextMonday('2026-10-25')).toBe('2026-10-26'); // Sunday
    expect(nextMonday('2026-10-29')).toBe('2026-11-02'); // Thursday
    expect(nextMonday('2026-10-27')).toBe('2026-11-02'); // Tuesday
  });
});

describe('datePresets', () => {
  test('today, tomorrow, next Monday, in a week', () => {
    const now = new Date(2026, 9, 29, 15).getTime();
    expect(datePresets(now).map(p => p.date)).toEqual([
      '2026-10-29',
      '2026-10-30',
      '2026-11-02',
      '2026-11-05',
    ]);
  });
});

describe('rowShortcut', () => {
  const el = new EventTarget();
  const press = (key: string, extra: object = {}) =>
    rowShortcut({
      key,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      repeat: false,
      target: el,
      currentTarget: el,
      ...extra,
    });
  test('maps keys', () => {
    expect(press('t')).toEqual({ type: 'due', offset: 0 });
    expect(press('m')).toEqual({ type: 'due', offset: 1 });
    expect(press('d')).toEqual({ type: 'pick-date' });
    expect(press('3')).toEqual({ type: 'priority', priority: 3 });
    expect(press(' ')).toEqual({ type: 'toggle' });
  });
  test('ignores modified keys and keys typed in a child field', () => {
    expect(press('t', { ctrlKey: true })).toBeNull();
    expect(press('t', { metaKey: true })).toBeNull();
    expect(press('t', { target: new EventTarget() })).toBeNull();
    expect(press('x')).toBeNull();
  });
});
