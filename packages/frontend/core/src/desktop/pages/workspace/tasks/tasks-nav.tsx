import type { TasksCounts, TasksViewId } from '@affine/core/modules/tasks';
import { useI18n } from '@affine/i18n';

import { VIEW_ICONS } from './task-list';
import * as styles from './tasks-page.css';
import { NAV_DIVIDER_AFTER, NAV_VIEWS } from './views';

export const TasksNav = ({
  view,
  counts,
  onSelect,
}: {
  view: TasksViewId;
  counts: TasksCounts;
  onSelect: (view: TasksViewId) => void;
}) => {
  const t = useI18n();
  return (
    <nav className={styles.nav} data-testid="tasks-nav">
      {NAV_VIEWS.map(id => (
        <div key={id} className={styles.navEntry}>
          <button
            type="button"
            className={styles.navItem}
            data-active={id === view}
            data-testid={`tasks-nav-${id}`}
            aria-current={id === view ? 'page' : undefined}
            onClick={() => onSelect(id)}
          >
            <span className={styles.navIcon}>{VIEW_ICONS[id]}</span>
            <span className={styles.navLabel}>
              {t[`com.affine.tasks.view.${id}`]()}
            </span>
            {counts[id] > 0 ? (
              <span className={styles.navCount}>{counts[id]}</span>
            ) : null}
          </button>
          {id === NAV_DIVIDER_AFTER ? (
            <div className={styles.navDivider} />
          ) : null}
        </div>
      ))}
    </nav>
  );
};
