import { IconButton } from '@affine/component';
import { Header } from '@affine/core/components/pure/header';
import { FeatureFlagService } from '@affine/core/modules/feature-flag';
import {
  addDays,
  localDay,
  type TaskRow,
  TasksService,
  type TasksViewId,
} from '@affine/core/modules/tasks';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewService,
  ViewSidebarTab,
  ViewTitle,
  WorkbenchService,
} from '@affine/core/modules/workbench';
import { inferOpenMode } from '@affine/core/utils';
import { useI18n } from '@affine/i18n';
import { InformationIcon, SidebarIcon } from '@blocksuite/icons/rc';
import { useLiveData, useService } from '@toeverything/infra';
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useState,
} from 'react';

import { PageNotFound } from '../../404';
import { TaskDetailContainer } from './detail-panel';
import { RowActions } from './row-actions';
import { TaskList, VIEW_ICONS } from './task-list';
import { TasksNav } from './tasks-nav';
import * as styles from './tasks-page.css';
import { isInbox, rowShortcut } from './triage';
import { useTaskActions } from './use-task-actions';
import { DEFAULT_VIEW, parseView, viewHref } from './views';

const DETAIL_TAB_ID = 'tasks-detail';

/** Below this width of the page the inner nav collapses behind a toggle. */
const NARROW_WIDTH = 900;

const useIsNarrow = (el: HTMLElement | null) => {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      setNarrow(width < NARROW_WIDTH);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return narrow;
};

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

  // ViewBody renders through a portal, so the element is only known after mount.
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const narrow = useIsNarrow(bodyEl);
  const [navOpen, setNavOpen] = useState(false);

  const selectView = useCallback(
    (next: TasksViewId) => {
      setNavOpen(false);
      if (next === view) return;
      viewEntity.history.push(viewHref(next));
    },
    [view, viewEntity]
  );
  const goToInbox = useCallback(() => selectView(DEFAULT_VIEW), [selectView]);

  const actions = useTaskActions();
  const toggleTask = actions.toggle;

  // Detail panel (workbench right sidebar). It tracks the task by id, so it
  // follows the task when triage moves it to another view.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const focusRow = useCallback(
    (id: string) => {
      bodyEl
        ?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`)
        ?.focus();
    },
    [bodyEl]
  );

  const openDetail = useCallback(
    (task: TaskRow) => {
      setSelectedId(task.id);
      workbench.openSidebar();
      viewEntity.activeSidebarTab(DETAIL_TAB_ID);
    },
    [viewEntity, workbench]
  );
  const closeDetail = useCallback(() => {
    const id = selectedId;
    setSelectedId(null);
    // Leave the sidebar alone when the user switched to another tab of it.
    if (viewEntity.activeSidebarTab$.value?.id === DETAIL_TAB_ID) {
      workbench.closeSidebar();
    }
    if (id) focusRow(id);
  }, [focusRow, selectedId, viewEntity, workbench]);

  // Row whose date menu was opened with `D`.
  const [dateMenu, setDateMenu] = useState<{
    id: string;
    pickerFirst: boolean;
  } | null>(null);

  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>, task: TaskRow) => {
      if (event.key === 'Escape' && selectedId) {
        event.preventDefault();
        event.stopPropagation();
        closeDetail();
        return;
      }
      const shortcut = rowShortcut(event);
      if (!shortcut) return;
      if (shortcut.type !== 'open') {
        event.preventDefault();
        event.stopPropagation();
      }
      switch (shortcut.type) {
        case 'due':
          actions.setDue(
            task,
            addDays(localDay(tasksService.now()), shortcut.offset)
          );
          break;
        case 'priority':
          actions.setPriority(task, shortcut.priority);
          break;
        case 'toggle':
          actions.toggle(task);
          break;
        case 'pick-date':
          // Only Inbox rows have the hover menu; others use the panel.
          if (isInbox(task)) setDateMenu({ id: task.id, pickerFirst: true });
          else openDetail(task);
          break;
        default:
          break;
      }
    },
    [actions, closeDetail, openDetail, selectedId, tasksService]
  );

  const renderRowActions = useCallback(
    (task: TaskRow) =>
      isInbox(task) ? (
        <RowActions
          task={task}
          dateMenuOpen={dateMenu?.id === task.id}
          pickerFirst={dateMenu?.id === task.id && dateMenu.pickerFirst}
          onDateMenuOpenChange={open =>
            setDateMenu(open ? { id: task.id, pickerFirst: false } : null)
          }
          onSetDue={actions.setDue}
          onSetPriority={actions.setPriority}
          onMenuClosed={t => focusRow(t.id)}
        />
      ) : null,
    [actions, dateMenu, focusRow]
  );

  const openSource = useCallback(
    (task: TaskRow, event: MouseEvent) => {
      workbench.openDoc(
        { docId: task.docId, blockIds: [task.blockId] },
        { at: inferOpenMode(event) }
      );
    },
    [workbench]
  );

  const retry = useCallback(() => tasksService.retry(), [tasksService]);

  return (
    <>
      <ViewTitle title={t['com.affine.tasks.title']()} />
      <ViewIcon icon="journal" />
      <ViewHeader>
        <Header
          left={
            <div className={styles.headerTitle}>
              {narrow ? (
                <IconButton
                  size="24"
                  data-testid="tasks-nav-toggle"
                  tooltip={t['com.affine.tasks.nav.toggle']()}
                  onClick={() => setNavOpen(open => !open)}
                >
                  <SidebarIcon />
                </IconButton>
              ) : null}
              <span className={styles.headerIcon}>{VIEW_ICONS[view]}</span>
              {t[`com.affine.tasks.view.${view}`]()}
            </div>
          }
        />
      </ViewHeader>
      <ViewBody>
        <div
          ref={setBodyEl}
          className={styles.body}
          data-narrow={narrow}
          data-nav-open={navOpen}
          data-testid="tasks-page"
        >
          <TasksNav view={view} counts={counts} onSelect={selectView} />
          <section className={styles.main}>
            <TaskList
              key={view}
              view={view}
              groups={groups}
              state={state}
              onRetry={retry}
              onGoToInbox={goToInbox}
              onToggle={toggleTask}
              onOpenSource={openSource}
              onOpenTask={openDetail}
              onRowKeyDown={handleRowKeyDown}
              renderRowActions={renderRowActions}
            />
          </section>
        </div>
      </ViewBody>
      <ViewSidebarTab tabId={DETAIL_TAB_ID} icon={<InformationIcon />}>
        <TaskDetailContainer
          selectedId={selectedId}
          onClose={closeDetail}
          onSetDue={actions.setDue}
          onSetPriority={actions.setPriority}
          onOpenSource={openSource}
        />
      </ViewSidebarTab>
    </>
  );
};

export const Component = () => {
  const featureFlagService = useService(FeatureFlagService);
  const enabled = useLiveData(featureFlagService.flags.enable_tasks_view.$);
  if (!enabled) return <PageNotFound />;
  return <TasksPage />;
};
