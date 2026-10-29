import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';

export const headerTitle = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 8px',
  fontWeight: 600,
  userSelect: 'none',
});

export const headerIcon = style({
  color: cssVar('iconColor'),
  fontSize: cssVar('fontH5'),
});

export const body = style({
  display: 'flex',
  flex: 1,
  width: '100%',
  height: '100%',
  minHeight: 0,
  borderTop: `0.5px solid ${cssVarV2.layer.insideBorder.border}`,
});

export const nav = style({
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  width: 210,
  flex: 'none',
  padding: '14px 8px',
  borderRight: `0.5px solid ${cssVarV2.layer.insideBorder.border}`,
  background: cssVarV2.layer.background.primary,
});

export const navItem = style({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '6px 10px',
  border: 'none',
  borderRadius: 6,
  background: 'none',
  color: cssVarV2.text.primary,
  fontSize: cssVar('fontSm'),
  textAlign: 'left',
  cursor: 'pointer',
  selectors: {
    '&:hover': { background: cssVarV2.layer.background.hoverOverlay },
    '&[data-active=true]': {
      background: cssVarV2.layer.background.hoverOverlay,
    },
  },
});

export const navIcon = style({
  display: 'inline-flex',
  fontSize: 20,
  color: cssVarV2.icon.primary,
});

export const navLabel = style({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const navCount = style({
  fontSize: 12,
  color: cssVarV2.text.secondary,
});

export const navDivider = style({
  height: 1,
  margin: '6px 10px',
  background: cssVarV2.layer.insideBorder.border,
});

export const main = style({
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minWidth: 0,
  paddingTop: 8,
});
