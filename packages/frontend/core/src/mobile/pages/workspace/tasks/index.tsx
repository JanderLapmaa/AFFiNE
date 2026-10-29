import { Modal, useThemeColorV2 } from '@affine/component';
import { TaskDetailContainer } from '@affine/core/components/tasks/detail-panel';
import { TaskList } from '@affine/core/components/tasks/task-list';
import { chip } from '@affine/core/components/tasks/triage-editor.css';
import { useTaskActions } from '@affine/core/components/tasks/use-task-actions';
import { TasksViewChips } from '@affine/core/components/tasks/view-chips';
import { parseView, viewHref } from '@affine/core/components/tasks/views';
import { FeatureFlagService } from '@affine/core/modules/feature-flag';
import {
  type TaskRow,
  TasksService,
  type TasksViewId,
} from '@affine/core/modules/tasks';
import { ViewService, WorkbenchService } from '@affine/core/modules/workbench';
import { useI18n } from '@affine/i18n';
import { useLiveData, useService } from '@toeverything/infra';
import { useCallback, useState } from 'react';

import { Page } from '../../../components/page';
import { PageHeader } from '../../../components/page-header';
import { useMobileVisualLayer } from '../../../modules/back-coordinator';
import { Component as NotFound } from '../../404';
import * as styles from './index.css';

const TasksPage = () => {
  const t = useI18n();
  const tasksService = useService(TasksService);
  const workbench = useService(WorkbenchService).workbench;
  const viewEntity = useService(ViewService).view;
  const location = useLiveData(viewEntity.location$);
  const view = parseView(new URLSearchParams(location.search).get('view'));
  const groups = useLiveData(tasksService.view$(view));
  const state = useLiveData(tasksService.state$);
  const counts = useLiveData(tasksService.counts$);
  const actions = useTaskActions();

  // The sheet tracks the task by id, so it stays open when triage moves the
  // task out of the current view.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const select = useCallback(
    (next: TasksViewId) => viewEntity.history.replace(viewHref(next)),
    [viewEntity]
  );
  const closeSheet = useCallback(() => setSelectedId(null), []);
  // Android back closes the sheet before it leaves the page.
  useMobileVisualLayer({
    enabled: selectedId !== null,
    interactive: false,
    onBack: closeSheet,
  });
  const openSource = useCallback(
    (task: TaskRow) => {
      setSelectedId(null);
      workbench.openDoc({ docId: task.docId, blockIds: [task.blockId] });
    },
    [workbench]
  );

  return (
    <Page
      header={
        <PageHeader
          bottom={
            <TasksViewChips
              view={view}
              counts={counts}
              onSelect={select}
              className={styles.chipRow}
              itemClassName={chip}
              countClassName={styles.chipCount}
            />
          }
          bottomSpacer={44}
        >
          {t['com.affine.tasks.title']()}
        </PageHeader>
      }
    >
      <TaskList
        key={view}
        view={view}
        groups={groups}
        state={state}
        onRetry={() => tasksService.retry()}
        onGoToInbox={() => select('inbox')}
        onToggle={actions.toggle}
        onOpenSource={openSource}
        onOpenTask={task => setSelectedId(task.id)}
      />
      <Modal
        open={selectedId !== null}
        onOpenChange={open => open || closeSheet()}
        width="100%"
        withoutCloseButton
        contentOptions={{ className: styles.sheet }}
      >
        <TaskDetailContainer
          selectedId={selectedId}
          onClose={closeSheet}
          onSetDue={actions.setDue}
          onSetPriority={actions.setPriority}
          onOpenSource={openSource}
        />
      </Modal>
    </Page>
  );
};

export const Component = () => {
  useThemeColorV2('layer/background/mobile/primary');
  const enabled = useLiveData(
    useService(FeatureFlagService).flags.enable_tasks_view.$
  );
  return enabled ? <TasksPage /> : <NotFound />;
};
