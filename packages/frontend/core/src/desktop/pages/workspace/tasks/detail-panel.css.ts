import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';

export const panel = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  height: '100%',
  padding: 16,
  overflowY: 'auto',
  outline: 'none',
});

export const header = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  fontSize: cssVar('fontSm'),
  fontWeight: 600,
  color: cssVarV2.text.primary,
});

export const title = style({
  fontSize: cssVar('fontBase'),
  lineHeight: '24px',
  fontWeight: 500,
  color: cssVarV2.text.primary,
  wordBreak: 'break-word',
  selectors: {
    '&[data-checked=true]': {
      textDecoration: 'line-through',
      color: cssVarV2.text.disable,
    },
  },
});

export const source = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  borderRadius: 8,
  border: `1px solid ${cssVarV2.layer.insideBorder.border}`,
  background: cssVarV2.layer.background.secondary,
});

export const sourceLabel = style({
  fontSize: 12,
  fontWeight: 500,
  color: cssVarV2.text.secondary,
});

export const sourceDoc = style({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  fontSize: cssVar('fontSm'),
  color: cssVarV2.text.primary,
});

export const sourceText = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const empty = style({
  padding: 24,
  textAlign: 'center',
  fontSize: cssVar('fontSm'),
  color: cssVarV2.text.secondary,
});

export const completedLine = style({
  fontSize: 12,
  color: cssVarV2.text.secondary,
});
