import type { TasksCounts, TasksViewId } from '@affine/core/modules/tasks';
import { useI18n } from '@affine/i18n';
import { Fragment, type ReactNode } from 'react';

import { VIEW_ICONS } from './task-list';
import { NAV_DIVIDER_AFTER, NAV_VIEWS } from './views';

export interface TasksViewChipsProps {
  view: TasksViewId;
  counts: TasksCounts;
  onSelect: (view: TasksViewId) => void;
  className: string;
  itemClassName: string;
  countClassName: string;
  /** Desktop nav: icon and label wrappers, a divider, and no zero counts. */
  nav?: {
    iconClassName: string;
    labelClassName: string;
    dividerClassName: string;
  };
}

/** The view switcher: the desktop inner nav and the mobile chip row. */
export const TasksViewChips = ({
  view,
  counts,
  onSelect,
  className,
  itemClassName,
  countClassName,
  nav,
}: TasksViewChipsProps) => {
  const t = useI18n();
  const wrap = (className: string | undefined, child: ReactNode) =>
    className ? <span className={className}>{child}</span> : child;
  return (
    <nav className={className} data-testid="tasks-nav">
      {NAV_VIEWS.map(id => (
        <Fragment key={id}>
          <button
            type="button"
            className={itemClassName}
            data-active={id === view}
            data-testid={`tasks-nav-${id}`}
            aria-current={id === view ? 'page' : undefined}
            onClick={() => onSelect(id)}
          >
            {nav ? wrap(nav.iconClassName, VIEW_ICONS[id]) : null}
            {wrap(nav?.labelClassName, t[`com.affine.tasks.view.${id}`]())}
            {nav && counts[id] === 0 ? null : (
              <span className={countClassName}>{counts[id]}</span>
            )}
          </button>
          {nav && id === NAV_DIVIDER_AFTER ? (
            <div className={nav.dividerClassName} />
          ) : null}
        </Fragment>
      ))}
    </nav>
  );
};
