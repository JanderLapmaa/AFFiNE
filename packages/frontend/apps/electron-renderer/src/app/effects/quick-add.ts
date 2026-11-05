import { FeatureFlagService } from '@affine/core/modules/feature-flag';
import { TasksService } from '@affine/core/modules/tasks';
import { apis, events } from '@affine/electron-api';
import type { FrameworkProvider } from '@toeverything/infra';

import { getCurrentWorkspace } from './utils';

type QuickAddResult = Parameters<
  NonNullable<typeof apis>['quickAdd']['respond']
>[1];

/** Adds a quick-add popup task to the current workspace's Tasks doc. */
async function addTask(
  frameworkProvider: FrameworkProvider,
  text: string
): Promise<QuickAddResult> {
  const flags = frameworkProvider.get(FeatureFlagService).flags;
  if (!flags.enable_tasks_view.value) return { ok: false, reason: 'disabled' };
  const current = getCurrentWorkspace(frameworkProvider);
  if (!current) return { ok: false, reason: 'no-workspace' };
  try {
    const { workspace } = current;
    const { due } = await workspace.scope.get(TasksService).quickAdd(text);
    return { ok: true, due, workspace: workspace.name$.value ?? undefined };
  } catch (error) {
    console.error(error);
    return {
      ok: false,
      reason: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    current.dispose();
  }
}

/**
 * The global quick-add popup hands its tasks to every app tab; the active
 * tab adds them to its workspace and answers.
 */
export function setupQuickAddEvents(frameworkProvider: FrameworkProvider) {
  events?.quickAdd.onSubmitRequest(({ requestId, text }) => {
    apis?.ui
      .isActiveTab()
      .then(async isActive => {
        if (!isActive) return;
        const result = await addTask(frameworkProvider, text);
        await apis?.quickAdd.respond(requestId, result);
      })
      .catch(console.error);
  });
}
