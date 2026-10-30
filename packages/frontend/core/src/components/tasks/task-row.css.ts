import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { globalStyle, style } from '@vanilla-extract/css';

const priorityColor = {
  0: cssVar('paletteLineGrey'),
  1: cssVar('paletteLineBlue'),
  2: cssVar('paletteLineOrange'),
  3: cssVar('paletteLineRed'),
} as const;

export const row = style({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '8px 8px',
  borderRadius: 6,
  cursor: 'pointer',
  outline: 'none',
  selectors: {
    '&:focus-visible, &[data-selected=true]': {
      background: cssVarV2.layer.background.hoverOverlay,
    },
    '&:focus-visible': {
      boxShadow: `inset 0 0 0 1px ${cssVarV2.layer.insideBorder.primaryBorder}`,
    },
  },
  '@media': {
    // Touch: a tap must not leave the row highlighted.
    '(hover: hover)': {
      selectors: {
        '&:hover': { background: cssVarV2.layer.background.hoverOverlay },
      },
    },
  },
});

export const checkboxWrapper = style({
  display: 'inline-flex',
  flex: 'none',
  fontSize: 20,
});

export const checkbox = style({
  fontSize: 20,
  color: priorityColor[0],
  selectors: {
    '&[data-priority="1"]': { color: priorityColor[1] },
    '&[data-priority="2"]': { color: priorityColor[2] },
    '&[data-priority="3"]': { color: priorityColor[3] },
  },
});
// The checked icon is drawn in a fixed blue; follow the priority colour.
globalStyle(`${checkbox} svg path`, { fill: 'currentColor' });

export const body = style({
  flex: 1,
  minWidth: 0,
});

export const title = style({
  fontSize: cssVar('fontSm'),
  lineHeight: '20px',
  color: cssVarV2.text.primary,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  selectors: {
    '&[data-checked=true]': {
      textDecoration: 'line-through',
      color: cssVarV2.text.disable,
    },
    // Mobile: up to two lines.
    '&[data-mobile=true]': {
      display: '-webkit-box',
      WebkitBoxOrient: 'vertical',
      WebkitLineClamp: 2,
      whiteSpace: 'normal',
    },
  },
});

export const source = style({
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  maxWidth: '100%',
  marginTop: 1,
  padding: 0,
  border: 'none',
  background: 'none',
  fontSize: 12,
  lineHeight: '18px',
  color: cssVarV2.text.secondary,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  selectors: {
    '&:hover:not([data-static])': { color: cssVarV2.text.link },
    '&[data-static]': { cursor: 'default' },
  },
});

export const sourceIcon = style({
  flex: 'none',
  fontSize: 14,
});

export const sourceText = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

export const trailing = style({
  display: 'flex',
  alignItems: 'center',
  flex: 'none',
  minHeight: 20,
  fontSize: 12,
  color: cssVarV2.text.secondary,
});

export const meta = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  lineHeight: '20px',
  selectors: {
    // Trailing actions replace the date and flag on hover or focus.
    [`${row}[data-has-actions=true]:hover &, ${row}[data-has-actions=true]:focus-within &`]:
      { display: 'none' },
    // ...and stay swapped while one of their menus is open (the pointer or
    // focus is then inside the portaled menu, not the row).
    [`${trailing}:has([data-state="open"]) &`]: { display: 'none' },
  },
});

export const overdue = style({
  color: cssVar('paletteLineRed'),
});

export const flag = style({
  fontSize: 14,
  color: priorityColor[0],
  selectors: {
    '&[data-priority="1"]': { color: priorityColor[1] },
    '&[data-priority="2"]': { color: priorityColor[2] },
    '&[data-priority="3"]': { color: priorityColor[3] },
  },
});

export const actions = style({
  display: 'none',
  alignItems: 'center',
  gap: 2,
  selectors: {
    [`${row}:hover &, ${row}:focus-within &, ${row} ${trailing}:has([data-state="open"]) &`]:
      { display: 'flex' },
  },
});

export const error = style({
  marginTop: 1,
  fontSize: 12,
  lineHeight: '18px',
  color: cssVarV2.status.error,
});
