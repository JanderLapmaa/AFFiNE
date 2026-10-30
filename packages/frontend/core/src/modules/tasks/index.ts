import { type Framework } from '@toeverything/infra';

import { WorkspaceServerService } from '../cloud/services/workspace-server';
import { DocsService } from '../doc';
import { JournalService } from '../journal';
import { GlobalCache } from '../storage';
import { WorkspaceScope, WorkspaceService } from '../workspace';
import { TasksService } from './services/tasks';
import { TasksClockStore } from './services/tasks-clock';
import { TasksCloudApi } from './services/tasks-cloud-api';

export { addDays, localDay } from './date';
export { TasksService } from './services/tasks';
export { TasksClockStore } from './services/tasks-clock';
export type {
  TaskGroup,
  TaskGroupKind,
  TaskPriority,
  TaskRow,
  TasksClock,
  TasksCounts,
  TasksState,
  TasksUndo,
  TasksViewId,
} from './types';

export function configureTasksModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .store(TasksClockStore)
    .service(TasksService, [
      WorkspaceService,
      DocsService,
      TasksClockStore,
      JournalService,
      TasksCloudApi,
      GlobalCache,
    ])
    .store(TasksCloudApi, [WorkspaceService, WorkspaceServerService]);
}
