import { TasksViewChips } from '@affine/core/components/tasks/view-chips';
import type { TasksCounts, TasksViewId } from '@affine/core/modules/tasks';

import * as styles from './tasks-page.css';

export const TasksNav = ({
  view,
  counts,
  onSelect,
}: {
  view: TasksViewId;
  counts: TasksCounts;
  onSelect: (view: TasksViewId) => void;
}) => (
  <TasksViewChips
    view={view}
    counts={counts}
    onSelect={onSelect}
    className={styles.nav}
    itemClassName={styles.navItem}
    countClassName={styles.navCount}
    nav={{
      iconClassName: styles.navIcon,
      labelClassName: styles.navLabel,
      dividerClassName: styles.navDivider,
    }}
  />
);
