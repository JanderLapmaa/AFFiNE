import { join } from 'node:path';

import { BrowserWindow, globalShortcut, screen } from 'electron';
import { Subject } from 'rxjs';

import { popupViewUrl } from '../../shared/internal-origin';
import { beforeAppQuit } from '../cleanup';
import { logger } from '../logger';
import type { MainEventRegister, NamespaceHandlers } from '../type';
import { buildWebPreferences } from '../web-preferences';
import { getAdditionalArguments } from '../windows-manager/popup';
import { QuickAddBroker, type QuickAddResult } from './broker';

export type { QuickAddRequest, QuickAddResult } from './broker';

/**
 * Opens the quick-add popup from anywhere on the computer: AltGr+A. Windows
 * reports AltGr as Ctrl+Alt, and Electron's `AltGr` modifier is dropped by the
 * Windows global hotkey (it would register plain `A`), so Ctrl+Alt+A is what
 * gets registered there.
 */
export const QUICK_ADD_SHORTCUT =
  process.platform === 'win32' ? 'Control+Alt+A' : 'AltGr+A';

/** The shortcut as shown to the user. */
export const QUICK_ADD_SHORTCUT_LABEL = 'AltGr+A';

/** A press this soon after the last one is ignored (key repeat, double press). */
const PRESS_DEBOUNCE_MS = 300;

/** How long after closing the popup is parked again (see `hide`). */
const PARK_DELAY_MS = 250;

/** Parked rather than hidden while closed (see `QuickAddWindow`). */
const PARKS = process.platform === 'win32';

/** Longest wait for the popup to repaint before it is shown anyway. */
const PAINT_TIMEOUT_MS = 150;

const WINDOW_NAME = 'quick-add';
const WIDTH = 560;
const HEIGHT = 90;

const broker = new QuickAddBroker();
const shown$ = new Subject<void>();
const hidden$ = new Subject<void>();
const painted$ = new Subject<void>();

/** On the screen the pointer is on, a little above the middle. */
function placement() {
  const { workArea } = screen.getDisplayNearestPoint(
    screen.getCursorScreenPoint()
  );
  return {
    x: Math.round(workArea.x + (workArea.width - WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height * 0.25),
    width: WIDTH,
    height: HEIGHT,
  };
}

/**
 * The quick-add popup: a small frameless window over everything else, built
 * at start-up and kept for every press; it closes when it loses focus.
 *
 * Windows fades a window in whenever it goes from hidden to shown, so the
 * popup is only hidden for a moment: closing it minimizes and hides it
 * (which hands focus back to the app the user was in; a plain hide leaves
 * focus on the hidden popup and the next press does nothing), then "parks"
 * it: shown again in place without focus, see-through and click-through. A
 * parked window keeps painting, so opening it is instant and shows the
 * cleared field, not the last task. Other platforms just hide it.
 */
class QuickAddWindow {
  private window: BrowserWindow | undefined;
  private ready: Promise<void> | undefined;
  /** Set once the window has loaded, so a press can open it at once. */
  private loaded = false;
  /** Whether the user sees it (it is parked otherwise). */
  private open = false;

  private async build() {
    const window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      // A tool window: kept out of Alt+Tab while parked.
      type: process.platform === 'win32' ? 'toolbar' : undefined,
      hiddenInMissionControl: true,
      titleBarStyle: 'hidden',
      backgroundColor: '#00000000',
      transparent: true,
      webPreferences: buildWebPreferences({
        spellcheck: false,
        transparent: true,
        // Kept awake while parked so a press is answered at once.
        backgroundThrottling: false,
        preload: join(__dirname, './preload.js'), // the bundled preload module
        additionalArguments: await getAdditionalArguments(WINDOW_NAME),
      }),
    });
    window.setAlwaysOnTop(true, 'pop-up-menu');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.on('blur', () => this.hide());
    window.on('closed', () => {
      if (this.window === window) {
        this.window = undefined;
        this.open = false;
      }
    });
    this.window = window;
    this.loaded = false;
    this.ready = new Promise<void>(resolve => {
      window.webContents.once('did-finish-load', () => {
        this.loaded = true;
        resolve();
      });
    });
    window.loadURL(popupViewUrl).catch(err => logger.error(err));
    return window;
  }

  /** Builds the window again when the main window took it down with it. */
  private async ensure() {
    if (!this.window || this.window.isDestroyed()) {
      await this.build();
    }
    await this.ready;
    return this.window as BrowserWindow;
  }

  /** Shown in place without focus, see-through and click-through. */
  private park() {
    const window = this.window;
    if (!PARKS || this.open || !window || window.isDestroyed()) return;
    window.setOpacity(0);
    window.setIgnoreMouseEvents(true);
    window.setBounds(placement());
    window.showInactive();
  }

  /** Builds and parks the window ahead of the first press. */
  prewarm() {
    this.ensure()
      .then(() => this.park())
      .catch(err => logger.error('quick add prewarm', err));
  }

  /**
   * Opens it. Called straight from the shortcut: Windows lets the app take
   * focus only while it handles the key press, so when the window is ready
   * it is shown synchronously, with no `await` before `focus()`.
   */
  async show() {
    const window =
      this.loaded && this.window && !this.window.isDestroyed()
        ? this.window
        : await this.ensure();
    this.open = true;
    // Stays see-through until the popup has repainted its empty field, so
    // the last frame (the previous task) never flashes up.
    window.setOpacity(0);
    window.setBounds(placement());
    window.setIgnoreMouseEvents(false);
    const painted = new Promise<void>(resolve => {
      const sub = painted$.subscribe(() => done());
      const timer = setTimeout(() => done(), PAINT_TIMEOUT_MS);
      function done() {
        sub.unsubscribe();
        clearTimeout(timer);
        resolve();
      }
    });
    // A real show even when parked: Windows lets it take focus then.
    window.show();
    window.moveTop();
    window.focus();
    window.webContents.focus();
    shown$.next();
    await painted;
    if (this.open && !window.isDestroyed()) window.setOpacity(1);
  }

  hide() {
    const window = this.window;
    if (!this.open || !window || window.isDestroyed()) return;
    this.open = false;
    window.setOpacity(0);
    if (PARKS) {
      window.setIgnoreMouseEvents(true);
      window.minimize();
    }
    window.hide();
    hidden$.next();
    if (PARKS) setTimeout(() => this.park(), PARK_DELAY_MS);
  }

  /** Closes it only when it has focus; otherwise it is (re)opened. */
  async toggle() {
    if (this.open && this.window?.isFocused()) this.hide();
    else await this.show();
  }
}

const quickAddWindow = new QuickAddWindow();

/** Registers the global shortcut; another app holding it only logs. */
export function setupQuickAdd() {
  let lastPress = 0;
  const registered = globalShortcut.register(QUICK_ADD_SHORTCUT, () => {
    const now = Date.now();
    if (now - lastPress < PRESS_DEBOUNCE_MS) return;
    lastPress = now;
    quickAddWindow.toggle().catch(err => logger.error('quick add', err));
  });
  if (!registered) {
    logger.warn(`quick add: ${QUICK_ADD_SHORTCUT} is taken by another app`);
  }
  beforeAppQuit(() => {
    globalShortcut.unregister(QUICK_ADD_SHORTCUT);
  });
  if (registered) quickAddWindow.prewarm();
}

export const quickAddHandlers = {
  /** From the popup: adds the task in the active tab's workspace. */
  submit: async (_, text: string): Promise<QuickAddResult> => {
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, reason: 'error' };
    }
    return broker.request(text);
  },
  /** From the active tab: the answer to a `onSubmitRequest`. */
  respond: async (_, requestId: string, result: QuickAddResult) => {
    broker.respond(requestId, result);
  },
  dismiss: async () => {
    quickAddWindow.hide();
  },
  /** From the popup: it has repainted after `onShown`, so it can be seen. */
  painted: async () => {
    painted$.next();
  },
  getShortcut: async () => QUICK_ADD_SHORTCUT_LABEL,
} satisfies NamespaceHandlers;

export const quickAddEvents = {
  /** To the app tabs: a task to add; only the active tab answers. */
  onSubmitRequest: (
    callback: (request: { requestId: string; text: string }) => void
  ) => {
    const sub = broker.requests$.subscribe(callback);
    return () => sub.unsubscribe();
  },
  /** To the popup: it was closed (clear it for the next time). */
  onHidden: (callback: () => void) => {
    const sub = hidden$.subscribe(() => callback());
    return () => sub.unsubscribe();
  },
  /** To the popup: it was just shown (clear and focus the field). */
  onShown: (callback: () => void) => {
    const sub = shown$.subscribe(() => callback());
    return () => sub.unsubscribe();
  },
} satisfies Record<string, MainEventRegister>;
