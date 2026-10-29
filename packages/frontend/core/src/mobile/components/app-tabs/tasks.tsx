import { TasksService } from '@affine/core/modules/tasks';
import { WorkbenchLink } from '@affine/core/modules/workbench';
import { useI18n } from '@affine/i18n';
import { DoneIcon } from '@blocksuite/icons/rc';
import { useLiveData, useService } from '@toeverything/infra';

import * as styles from './styles.css';
import { TabItem } from './tab-item';
import type { AppTabCustomFCProps } from './type';

/** Replaces the All docs tab while `enable_tasks_view` is on; a dot marks a non-empty Inbox. */
export const AppTabTasks = ({ tab }: AppTabCustomFCProps) => {
  const t = useI18n();
  const hasInbox = useLiveData(useService(TasksService).inboxCount$) > 0;
  return (
    <WorkbenchLink className={styles.tabItem} to="/tasks" replaceHistory>
      <TabItem id={tab.key} label={t['com.affine.tasks.title']()}>
        <span className={styles.badgeHost}>
          <DoneIcon />
          {hasInbox ? (
            <span className={styles.badge} data-testid="app-tab-tasks-badge" />
          ) : null}
        </span>
      </TabItem>
    </WorkbenchLink>
  );
};
