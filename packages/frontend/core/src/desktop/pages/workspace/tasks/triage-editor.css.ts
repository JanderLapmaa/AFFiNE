import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';

export const editor = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
});

export const part = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minWidth: 0,
});

export const label = style({
  fontSize: 12,
  lineHeight: '16px',
  fontWeight: 500,
  color: cssVarV2.text.secondary,
});

export const chips = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
});

export const chip = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: 28,
  padding: '0 10px',
  border: `1px solid ${cssVarV2.layer.insideBorder.border}`,
  borderRadius: 14,
  background: cssVarV2.layer.background.primary,
  color: cssVarV2.text.primary,
  fontSize: cssVar('fontXs'),
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  selectors: {
    '&:hover': { background: cssVarV2.layer.background.hoverOverlay },
    '&[data-active=true]': {
      borderColor: cssVarV2.button.primary,
      color: cssVarV2.button.primary,
    },
    '&:focus-visible': {
      outline: `2px solid ${cssVarV2.layer.insideBorder.primaryBorder}`,
      outlineOffset: 1,
    },
  },
});

export const priorityDot = style({
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: cssVar('paletteLineGrey'),
  selectors: {
    '&[data-priority="1"]': { background: cssVar('paletteLineBlue') },
    '&[data-priority="2"]': { background: cssVar('paletteLineOrange') },
    '&[data-priority="3"]': { background: cssVar('paletteLineRed') },
  },
});

export const picker = style({
  display: 'flex',
  justifyContent: 'center',
});

export const menuContent = style({
  width: 280,
  padding: 12,
});

export const menuContentNarrow = style({
  width: 'auto',
  padding: 12,
});
