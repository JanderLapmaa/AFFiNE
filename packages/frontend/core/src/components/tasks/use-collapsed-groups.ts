import type { TasksViewId } from '@affine/core/modules/tasks';
import { WorkspaceLocalState } from '@affine/core/modules/workspace';
import { LiveData, useLiveData, useService } from '@toeverything/infra';
import { useCallback, useMemo } from 'react';

const EMPTY: string[] = [];

/**
 * Collapsed group keys of one view, remembered per view on this device
 * (workspace local state, like the All docs display options).
 */
export function useCollapsedGroups(view: TasksViewId) {
  const localState = useService(WorkspaceLocalState);
  const storageKey = `tasksCollapsedGroups:${view}`;

  const collapsed$ = useMemo(
    () =>
      LiveData.from(
        localState.watch<string[]>(storageKey),
        localState.get<string[]>(storageKey)
      ),
    [localState, storageKey]
  );
  const collapsed = useLiveData(collapsed$) ?? EMPTY;

  const isCollapsed = useCallback(
    (groupKey: string) => collapsed.includes(groupKey),
    [collapsed]
  );

  const toggle = useCallback(
    (groupKey: string) => {
      const current = localState.get<string[]>(storageKey) ?? EMPTY;
      const next = current.includes(groupKey)
        ? current.filter(k => k !== groupKey)
        : [...current, groupKey];
      if (next.length) localState.set(storageKey, next);
      else localState.del(storageKey);
    },
    [localState, storageKey]
  );

  return { isCollapsed, toggle };
}
