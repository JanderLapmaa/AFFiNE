import { I18nService } from '@affine/core/modules/i18n';
import type { ParsedQuickAdd } from '@affine/core/modules/tasks/quick-add';
import { useI18n } from '@affine/i18n';
import { useLiveData, useService } from '@toeverything/infra';

import * as styles from './add-task-field.css';
import { dueLabel } from './format';

const PRIORITY_KEYS = [
  null,
  'com.affine.tasks.priority.low',
  'com.affine.tasks.priority.medium',
  'com.affine.tasks.priority.high',
] as const;

/**
 * The date and priority read from the tokens typed so far. Needs only i18n,
 * so the desktop quick-add popup (no workspace) can show it too.
 */
export const QuickAddPreview = ({
  parsed,
  now,
  className,
}: {
  parsed: ParsedQuickAdd;
  now: number;
  className?: string;
}) => {
  const t = useI18n();
  const i18n = useService(I18nService).i18n;
  const locale = useLiveData(i18n.currentLanguage$)?.key ?? 'en';
  const priorityKey = parsed.priority ? PRIORITY_KEYS[parsed.priority] : null;
  if (!parsed.due && !priorityKey) return null;
  return (
    <div
      className={className ?? styles.preview}
      data-testid="tasks-add-preview"
    >
      {parsed.due ? (
        <span className={styles.token}>
          {dueLabel(parsed.due, t, { relativePast: false }, now, locale)}
        </span>
      ) : null}
      {priorityKey ? (
        <span className={styles.token}>{t[priorityKey]()}</span>
      ) : null}
    </div>
  );
};
