import { Subject } from 'rxjs';

/** What adding a task from the quick-add popup did. */
export type QuickAddResult =
  | {
      ok: true;
      /** `YYYY-MM-DD`, or null for Inbox */
      due: string | null;
      /** Name of the workspace the task went to. */
      workspace?: string;
    }
  | {
      ok: false;
      /** `no-workspace`: no open workspace answered in time. */
      reason: 'no-workspace' | 'disabled' | 'error';
      message?: string;
    };

export interface QuickAddRequest {
  requestId: string;
  text: string;
}

/** How long the popup waits for a workspace tab to take a task. */
export const QUICK_ADD_TIMEOUT_MS = 10_000;

/**
 * Hands the popup's tasks to the app tabs: a request goes out to every tab,
 * the active one adds the task to its workspace and answers. Without an
 * answer in time the request gives `no-workspace`.
 */
export class QuickAddBroker {
  readonly requests$ = new Subject<QuickAddRequest>();
  private readonly pending = new Map<
    string,
    (result: QuickAddResult) => void
  >();
  private nextId = 0;

  constructor(private readonly timeoutMs = QUICK_ADD_TIMEOUT_MS) {}

  request(text: string): Promise<QuickAddResult> {
    const requestId = `quick-add-${Date.now()}-${++this.nextId}`;
    return new Promise<QuickAddResult>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, reason: 'no-workspace' });
      }, this.timeoutMs);
      this.pending.set(requestId, result => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(result);
      });
      this.requests$.next({ requestId, text });
    });
  }

  /** The first answer to a request wins; later or unknown ones are ignored. */
  respond(requestId: string, result: QuickAddResult) {
    this.pending.get(requestId)?.(result);
  }
}
