import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';

export const chipRow = style({
  display: 'flex',
  gap: 8,
  height: 44,
  padding: '8px 16px',
  boxSizing: 'border-box',
  overflowX: 'auto',
  scrollbarWidth: 'none',
  background: cssVarV2.layer.background.primary,
});

export const chipCount = style({
  color: cssVarV2.text.secondary,
});

export const sheet = style({
  minHeight: 0,
  maxHeight: '85dvh',
  padding: 0,
  borderRadius: '22px 22px 0 0',
});
