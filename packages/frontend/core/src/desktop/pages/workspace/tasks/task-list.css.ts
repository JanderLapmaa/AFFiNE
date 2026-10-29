import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { globalStyle, style } from '@vanilla-extract/css';

export const list = style({
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '0 24px 24px',
});

export const group = style({
  marginTop: 10,
});

export const groupHeader = style({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  padding: '6px 0',
  border: 'none',
  background: 'none',
  color: cssVarV2.text.secondary,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  userSelect: 'none',
  textAlign: 'left',
  selectors: {
    '&[data-overdue=true]': { color: cssVar('paletteLineRed') },
  },
});

globalStyle(`${groupHeader} svg`, { flex: 'none', fontSize: 16 });

export const groupTitle = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const groupCount = style({
  fontWeight: 400,
  color: cssVarV2.text.disable,
});

export const skeletonRow = style({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '8px 8px',
});

export const skeletonText = style({
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
});

export const errorBanner = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  margin: '10px 0',
  padding: '8px 12px',
  borderRadius: 8,
  border: `1px solid ${cssVar('paletteLineRed')}`,
  background: cssVarV2.layer.background.secondary,
  color: cssVarV2.text.primary,
  fontSize: cssVar('fontSm'),
});

export const errorText = style({
  fontWeight: 500,
});

export const empty = style({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  textAlign: 'center',
  gap: 6,
  padding: '90px 20px',
});

export const emptyIcon = style({
  fontSize: 44,
  color: cssVarV2.icon.secondary,
});

export const emptyTitle = style({
  margin: '8px 0 0',
  fontSize: 16,
  fontWeight: 600,
  color: cssVarV2.text.primary,
});

export const emptyDescription = style({
  margin: '0 0 10px',
  maxWidth: 340,
  fontSize: cssVar('fontSm'),
  color: cssVarV2.text.secondary,
});
