import { Store } from '@toeverything/infra';

import type { TasksClock } from '../types';

/**
 * Source of "now" for the tasks service. Replace it in tests with a fixed
 * clock; "today" is always the local calendar day of `now()`.
 */
export class TasksClockStore extends Store implements TasksClock {
  now() {
    return Date.now();
  }
}
