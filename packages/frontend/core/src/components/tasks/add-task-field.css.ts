import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { globalStyle, style } from '@vanilla-extract/css';

export const root = style({
  margin: '10px 0 4px',
});

export const field = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  borderRadius: 8,
  border: `1px solid ${cssVarV2.layer.insideBorder.border}`,
  background: cssVarV2.layer.background.primary,
  color: cssVarV2.icon.primary,
  cursor: 'text',
  selectors: {
    '&:focus-within': {
      borderColor: cssVarV2.button.primary,
    },
  },
});

globalStyle(`${field} svg`, { flex: 'none', fontSize: 18 });

export const input = style({
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: cssVarV2.text.primary,
  fontSize: cssVar('fontBase'),
  lineHeight: '24px',
  '::placeholder': { color: cssVarV2.text.placeholder },
});

export const preview = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 6,
  paddingLeft: 2,
  color: cssVarV2.text.secondary,
  fontSize: cssVar('fontXs'),
});

export const token = style({
  padding: '0 6px',
  borderRadius: 4,
  background: cssVarV2.layer.background.secondary,
  lineHeight: '20px',
});
