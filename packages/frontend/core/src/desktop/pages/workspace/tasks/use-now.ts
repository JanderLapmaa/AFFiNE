import { I18nService } from '@affine/core/modules/i18n';
import { TasksService } from '@affine/core/modules/tasks';
import { useLiveData, useService } from '@toeverything/infra';

/** "Now" from the tasks clock, so the UI and the service agree on today. */
export function useNow() {
  return useService(TasksService).now();
}

/** BCP-47 tag of the app language, for `Intl`. */
export function useLocale() {
  const i18n = useService(I18nService).i18n;
  return useLiveData(i18n.currentLanguage$)?.key ?? 'en';
}
