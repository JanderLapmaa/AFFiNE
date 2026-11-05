import { describe, expect, it } from 'vitest';

import { parseQuickAdd } from '../quick-add';

// Wednesday 28 Oct 2026
const TODAY = '2026-10-28';

describe('parseQuickAdd', () => {
  it.each([
    ['Call bank', { text: 'Call bank' }],
    [
      'Call bank @tomorrow !high',
      { text: 'Call bank', due: '2026-10-29', priority: 3 },
    ],
    ['@today pay rent', { text: 'pay rent', due: TODAY }],
    ['a @tmr b', { text: 'a b', due: '2026-10-29' }],
    // weekdays: the nearest such day, today included
    ['x @wed', { text: 'x', due: TODAY }],
    ['x @thu', { text: 'x', due: '2026-10-29' }],
    ['x @Tuesday', { text: 'x', due: '2026-11-03' }],
    ['x @fri', { text: 'x', due: '2026-10-30' }],
    // next week: the coming Monday
    ['x @nextweek', { text: 'x', due: '2026-11-02' }],
    ['x @+3d', { text: 'x', due: '2026-10-31' }],
    ['x @+0d', { text: 'x', due: TODAY }],
    ['x @2026-12-24', { text: 'x', due: '2026-12-24' }],
    ['x !1', { text: 'x', priority: 1 }],
    ['x !2', { text: 'x', priority: 2 }],
    ['x !3', { text: 'x', priority: 3 }],
    ['x !low', { text: 'x', priority: 1 }],
    ['x !med', { text: 'x', priority: 2 }],
    ['x !medium', { text: 'x', priority: 2 }],
    ['x !HIGH', { text: 'x', priority: 3 }],
  ])('%s', (input, expected) => {
    expect(parseQuickAdd(input, TODAY)).toEqual(expected);
  });

  it('keeps words that are not tokens', () => {
    expect(parseQuickAdd('mail a@b.com @someone !wow ! @ !4', TODAY)).toEqual({
      text: 'mail a@b.com @someone !wow ! @ !4',
    });
  });

  it('keeps invalid dates in the text', () => {
    expect(parseQuickAdd('x @2026-02-31 @2026-13-01', TODAY)).toEqual({
      text: 'x @2026-02-31 @2026-13-01',
    });
  });

  it('lets the last token of a kind win', () => {
    expect(parseQuickAdd('x @today !low @tomorrow !high', TODAY)).toEqual({
      text: 'x',
      due: '2026-10-29',
      priority: 3,
    });
  });

  it('leaves no text when there are only tokens', () => {
    expect(parseQuickAdd('  @today   !high ', TODAY)).toEqual({
      text: '',
      due: TODAY,
      priority: 3,
    });
  });

  it('crosses months and years', () => {
    expect(parseQuickAdd('x @tomorrow', '2026-12-31').due).toBe('2027-01-01');
    expect(parseQuickAdd('x @+30d', '2026-12-15').due).toBe('2027-01-14');
  });
});
