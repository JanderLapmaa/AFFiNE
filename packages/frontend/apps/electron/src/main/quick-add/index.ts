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

/** Opens the quick-add popup from anywhere on the computer. */
export const QUICK_ADD_SHORTCUT = 'Alt+A';

const WINDOW_NAME = 'quick-add';
const WIDTH = 560;
const HEIGHT = 132;

const broker = new QuickAddBroker();
const shown$ = new Subject<void>();

/**
 * The quick-add popup: a small frameless window over everything else, built
 * on first use and kept (hidden) for the next one. It hides when it loses
 * focus.
 */
class QuickAddWindow {
  private window: BrowserWindow | undefined;
  private ready: Promise<void> | undefined;

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
      hiddenInMissionControl: true,
      titleBarStyle: 'hidden',
      backgroundColor: '#00000000',
      transparent: true,
      webPreferences: buildWebPreferences({
        spellcheck: false,
        transparent: true,
        preload: join(__dirname, './preload.js'), // the bundled preload module
        additionalArguments: await getAdditionalArguments(WINDOW_NAME),
      }),
    });
    window.setAlwaysOnTop(true, 'pop-up-menu');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.on('blur', () => window.hide());
    this.window = window;
    this.ready = new Promise<void>(resolve => {
      window.webContents.once('did-finish-load', () => resolve());
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

  async show() {
    const window = await this.ensure();
    // On the screen the pointer is on, a little above the middle.
    const { workArea } = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint()
    );
    window.setBounds({
      x: Math.round(workArea.x + (workArea.width - WIDTH) / 2),
      y: Math.round(workArea.y + workArea.height * 0.25),
      width: WIDTH,
      height: HEIGHT,
    });
    window.show();
    window.moveTop();
    window.focus();
    window.webContents.focus();
    shown$.next();
  }

  hide() {
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  get visible() {
    return (
      !!this.window && !this.window.isDestroyed() && this.window.isVisible()
    );
  }

  async toggle() {
    if (this.visible) this.hide();
    else await this.show();
  }
}

const quickAddWindow = new QuickAddWindow();

/** Registers the global shortcut; another app holding it only logs. */
export function setupQuickAdd() {
  const registered = globalShortcut.register(QUICK_ADD_SHORTCUT, () => {
    quickAddWindow.toggle().catch(err => logger.error('quick add', err));
  });
  if (!registered) {
    logger.warn(`quick add: ${QUICK_ADD_SHORTCUT} is taken by another app`);
  }
  beforeAppQuit(() => {
    globalShortcut.unregister(QUICK_ADD_SHORTCUT);
  });
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
  getShortcut: async () => QUICK_ADD_SHORTCUT,
} satisfies NamespaceHandlers;

export const quickAddEvents = {
  /** To the app tabs: a task to add; only the active tab answers. */
  onSubmitRequest: (
    callback: (request: { requestId: string; text: string }) => void
  ) => {
    const sub = broker.requests$.subscribe(callback);
    return () => sub.unsubscribe();
  },
  /** To the popup: it was just shown (clear and focus the field). */
  onShown: (callback: () => void) => {
    const sub = shown$.subscribe(() => callback());
    return () => sub.unsubscribe();
  },
} satisfies Record<string, MainEventRegister>;
