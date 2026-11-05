import { dueLabel } from '@affine/core/components/tasks/format';
import { QuickAddPreview } from '@affine/core/components/tasks/quick-add-preview';
import { localDay } from '@affine/core/modules/tasks/date';
import { parseQuickAdd } from '@affine/core/modules/tasks/quick-add';
import { apis, events } from '@affine/electron-api';
import { useI18n } from '@affine/i18n';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';

import * as styles from './styles.css';

/** How long "Added to …" shows before the popup hides. */
const DONE_MS = 700;

type Status =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string };

/**
 * The quick-add popup (global shortcut). Enter hands the text to the active
 * app tab, which adds it to its workspace's Tasks doc; Esc closes it.
 */
export function QuickAdd() {
  const t = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [now, setNow] = useState(() => Date.now());
  const parsed = useMemo(() => parseQuickAdd(text, localDay(now)), [now, text]);

  // Cleared when it closes, so it is already empty when it is next shown;
  // shown again, it is cleared once more (the date may have changed) and the
  // window stays see-through until that has been painted (`painted`).
  useEffect(() => {
    const clear = () => {
      flushSync(() => {
        setText('');
        setStatus({ kind: 'idle' });
        setNow(Date.now());
      });
    };
    const offHidden = events?.quickAdd.onHidden(clear);
    const offShown = events?.quickAdd.onShown(() => {
      clear();
      inputRef.current?.focus();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          apis?.quickAdd.painted().catch(console.error);
        })
      );
    });
    return () => {
      offHidden?.();
      offShown?.();
    };
  }, []);

  const submit = useCallback(async () => {
    if (!parsed.text || status.kind === 'busy' || !apis) return;
    setStatus({ kind: 'busy' });
    const result = await apis.quickAdd.submit(text).catch(error => ({
      ok: false as const,
      reason: 'error' as const,
      message: String(error),
    }));
    if (result.ok) {
      const where = result.due
        ? dueLabel(result.due, t, { relativePast: false })
        : t['com.affine.tasks.view.inbox']();
      setText('');
      setStatus({
        kind: 'done',
        message: t['com.affine.tasks.toast.added']({ where }),
      });
      setTimeout(() => {
        apis?.quickAdd.dismiss().catch(console.error);
      }, DONE_MS);
    } else {
      setStatus({
        kind: 'error',
        message:
          result.reason === 'no-workspace' || result.reason === 'disabled'
            ? t['com.affine.tasks.quick-add.no-workspace']()
            : t['com.affine.tasks.toast.error'](),
      });
    }
  }, [parsed.text, status.kind, t, text]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
        event.preventDefault();
        submit().catch(console.error);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        apis?.quickAdd.dismiss().catch(console.error);
      }
    },
    [submit]
  );

  const statusText =
    status.kind === 'busy'
      ? t['com.affine.tasks.quick-add.adding']()
      : status.kind === 'done' || status.kind === 'error'
        ? status.message
        : t['com.affine.tasks.quick-add.hint']();

  return (
    <div className={styles.root} data-testid="quick-add-popup">
      <label className={styles.field}>
        <span className={styles.plus} aria-hidden="true">
          +
        </span>
        <input
          ref={inputRef}
          autoFocus
          className={styles.input}
          value={text}
          onChange={e => {
            setText(e.target.value);
            if (status.kind === 'error') setStatus({ kind: 'idle' });
          }}
          onKeyDown={onKeyDown}
          placeholder={t['com.affine.tasks.add.placeholder']()}
          aria-label={t['com.affine.tasks.add.label']()}
        />
      </label>
      <div className={styles.footer}>
        <QuickAddPreview parsed={parsed} now={now} className={styles.preview} />
        <span className={styles.status} data-kind={status.kind}>
          {statusText}
        </span>
      </div>
    </div>
  );
}
