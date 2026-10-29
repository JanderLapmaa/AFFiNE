import { MenuLinkItem } from '@affine/core/modules/app-sidebar/views';
import { FeatureFlagService } from '@affine/core/modules/feature-flag';
import { TasksService } from '@affine/core/modules/tasks';
import { WorkbenchService } from '@affine/core/modules/workbench';
import { useI18n } from '@affine/i18n';
import { DoneIcon } from '@blocksuite/icons/rc';
import { useLiveData, useService } from '@toeverything/infra';

import * as styles from './notification-button.style.css';

const Badge = ({ count }: { count: number }) => {
  if (count === 0) {
    return null;
  }
  return (
    <div className={styles.badge} data-testid="slider-bar-tasks-badge">
      {count > 99 ? '99+' : count}
    </div>
  );
};

const TasksButtonInner = () => {
  const t = useI18n();
  const tasksService = useService(TasksService);
  const workbench = useService(WorkbenchService).workbench;
  const location = useLiveData(workbench.location$);
  const inboxCount = useLiveData(tasksService.inboxCount$);

  return (
    <MenuLinkItem
      data-testid="slider-bar-tasks-button"
      active={location.pathname.startsWith('/tasks')}
      to="/tasks"
      icon={<DoneIcon />}
      postfix={<Badge count={inboxCount} />}
      postfixDisplay="always"
    >
      {t['com.affine.tasks.title']()}
    </MenuLinkItem>
  );
};

/** Sidebar entry of the Tasks view. Hidden when `enable_tasks_view` is off. */
export const TasksButton = () => {
  const featureFlagService = useService(FeatureFlagService);
  const enabled = useLiveData(featureFlagService.flags.enable_tasks_view.$);
  if (!enabled) return null;
  return <TasksButtonInner />;
};
