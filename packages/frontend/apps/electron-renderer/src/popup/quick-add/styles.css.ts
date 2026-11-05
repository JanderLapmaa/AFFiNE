import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { globalStyle, style } from '@vanilla-extract/css';

export const root = style({
  boxSizing: 'border-box',
  width: '100%',
  height: '100%',
  padding: '14px 16px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  borderRadius: 12,
  border: `1px solid ${cssVarV2.layer.insideBorder.border}`,
  background: cssVarV2.layer.background.overlayPanel,
  color: cssVarV2.text.primary,
  overflow: 'hidden',
});

export const field = style({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  color: cssVarV2.icon.primary,
});

globalStyle(`${field} svg`, { flex: 'none', fontSize: 22 });

export const input = style({
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: cssVarV2.text.primary,
  fontSize: 18,
  lineHeight: '28px',
  '::placeholder': { color: cssVarV2.text.placeholder },
});

export const footer = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  minHeight: 22,
  color: cssVarV2.text.secondary,
  fontSize: cssVar('fontXs'),
});

export const preview = style({
  display: 'flex',
  gap: 6,
});

export const status = style({
  selectors: {
    '&[data-kind=error]': { color: cssVar('paletteLineRed') },
    '&[data-kind=done]': { color: cssVarV2.text.primary },
  },
});

export const plus = style({
  flex: 'none',
  width: 22,
  textAlign: 'center',
  fontSize: 22,
  lineHeight: '28px',
  color: cssVarV2.icon.secondary,
});
