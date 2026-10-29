import { AllDocsIcon, HomeIcon } from '@blocksuite/icons/rc';

import { AppTabCreate } from './create';
import { AppTabJournal } from './journal';
import { AppTabTasks } from './tasks';
import type { Tab } from './type';

const home: Tab = { key: 'home', to: '/home', Icon: HomeIcon };
const all: Tab = { key: 'all', to: '/all', Icon: AllDocsIcon };
const journal: Tab = { key: 'journal', custom: AppTabJournal };
const tasks: Tab = { key: 'tasks', custom: AppTabTasks };
const create: Tab = { key: 'new', custom: AppTabCreate };

/** The Tasks tab replaces All docs while `enable_tasks_view` is on. */
export const getTabs = (tasksEnabled: boolean): Tab[] =>
  tasksEnabled ? [home, journal, tasks, create] : [home, all, journal, create];
