import { type Framework } from '@toeverything/infra';

import { DocsService } from '../doc';
import { WorkspaceScope, WorkspaceService } from '../workspace';
import { TasksService } from './services/tasks';
import { TasksClockStore } from './services/tasks-clock';

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
  TasksViewId,
} from './types';

export function configureTasksModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .store(TasksClockStore)
    .service(TasksService, [WorkspaceService, DocsService, TasksClockStore]);
}
