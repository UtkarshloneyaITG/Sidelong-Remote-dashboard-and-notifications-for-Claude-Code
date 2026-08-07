/**
 * Electron main. Wiring only -- no state machine lives here.
 *
 * Data flow, in one direction:
 *   Claude Code hook -> IngestServer -> ClaudeCodeAdapter.ingest -> reduce()
 *     -> buildView() -> IPC 'view' -> renderer renders it.
 *
 * The renderer can never write to that flow. Every channel it can invoke changes
 * window geometry, focus, or hook installation -- none of them touch agent state.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  BrowserWindow, app, dialog, globalShortcut, ipcMain, screen, shell,
} from 'electron';
import {
  PERMISSION_GRACE_MS, buildView, hookBaseUrl, prunable,
  type BridgeInfo, type OverlayView,
} from '@agent-watcher/protocol';
import { AdapterRegistry, ClaudeCodeAdapter } from '@agent-watcher/agent-adapters';

import { DEFAULT_PORT, loadConfig, updateConfig } from './config.js';
import { IngestServer, PortInUseError } from './ingest.js';
import { BridgeServer } from './bridge-server.js';
import { Notifier } from './notifier.js';
import * as hooks from './hooks-installer.js';

// Set BEFORE anything reads app.getPath('userData'): the package name is scoped
// ("@agent-watcher/desktop") and would otherwise become a nested directory. The
// VS Code bridge looks for the token at this exact folder name.
app.setName('agent-watcher-desktop');

/**
 * ONE size for the minimized bar, always.
 *
 * It used to resize itself to fit its content, which meant the window jumped
 * every time a command started or a prompt appeared -- distracting in exactly
 * the peripheral-vision role this thing is for. The bar is now fixed and the
 * content adapts inside it: the command truncates, and the buttons fade in on
 * top of its right edge instead of taking layout space.
 */
const BAR = { width: 560, height: 56 };
const EXPANDED = { width: 348, height: 428 };
/** Recompute elapsed/staleness. Cannot change a status -- buildView never does. */
const VIEW_TICK_MS = 2_000;
/** A DISCONNECTED session is forgotten after this long. */
const SESSION_TTL_MS = 10 * 60_000;

let win: BrowserWindow | undefined;
let ingest: IngestServer | undefined;
let bridge: BridgeServer | undefined;
let notifier: Notifier | undefined;
let collapseTimer: NodeJS.Timeout | undefined;
let graceTimer: NodeJS.Timeout | undefined;
let hookMessage: string | undefined;
/**
 * sessionId -> the permission key you clicked [ok] on. Lives in MAIN, not the
 * renderer, and is never fed back into the reducer: acknowledging is a display
 * preference, not an agent state change, and it is emphatically not approval.
 */
const acknowledged: Record<string, string> = {};

const registry = new AdapterRegistry();
const claude = new ClaudeCodeAdapter();
registry.register(claude);

// -------------------------------------------------------------------- window

function createWindow(): BrowserWindow {
  const cfg = loadConfig();
  const size = cfg.expanded ? EXPANDED : BAR;
  const area = screen.getPrimaryDisplay().workArea;

  const w = new BrowserWindow({
    ...size,
    x: cfg.bounds?.x ?? area.x + area.width - size.width - 24,
    y: cfg.bounds?.y ?? area.y + 24,
    frame: false,
    transparent: true,
    resizable: true,
    // Size the CONTENT, not the window rect. A frameless resizable window on
    // Windows still carries an invisible resize border, and without this the
    // card ends up a few pixels short of what the layout was designed for.
    useContentSize: true,
    minWidth: 220,
    minHeight: 40,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    // Never steal focus: the whole point is to be readable from another app.
    focusable: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 'screen-saver' is the level that actually floats over full-screen Chrome and
  // over VS Code's own always-on-top surfaces.
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  w.on('moved', () => saveBounds(w));
  w.on('resized', () => saveBounds(w));
  w.on('closed', () => { win = undefined; });

  if (process.env.ELECTRON_RENDERER_URL) {
    void w.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void w.loadFile(join(__dirname, '../renderer/index.html'));
  }
  w.once('ready-to-show', () => w.showInactive());
  return w;
}

function saveBounds(w: BrowserWindow): void {
  // Only the position is restored on next launch; the size always comes from
  // the collapsed/expanded constants, so a stray drag cannot leave the overlay
  // permanently the wrong shape.
  const b = w.getBounds();
  updateConfig({ bounds: { x: b.x, y: b.y, width: b.width, height: b.height } });
}

function setExpanded(expanded: boolean): void {
  updateConfig({ expanded });
  if (!win) return;
  // setContentSize keeps the CSS card exactly the size the layout assumes.
  // The bar is a fixed size, so this is the ONLY place the window ever resizes.
  const size = expanded ? EXPANDED : BAR;
  win.setContentSize(size.width, size.height);
  pushView();
}

// ---------------------------------------------------------------- view push

function currentView(): OverlayView {
  const cfg = loadConfig();
  return buildView(registry.mergedState(), {
    now: Date.now(),
    staleMs: cfg.staleMs,
    bridge: bridge?.getInfo() ?? ({ status: 'disconnected' } as BridgeInfo),
    ingestReady: Boolean(ingest?.raw()),
    hookConfigDrift: hookMessage,
    acknowledged,
  });
}

function pushView(): void {
  const view = currentView();
  win?.webContents.send('view', { ...view, expanded: loadConfig().expanded });
  notifier?.update(view);

  // A prompt inside its grace window becomes actionable on a clock, not on an
  // event. Schedule the exact push that flips it, so a real permission surfaces
  // ~700ms after it arrives instead of waiting for the next 2s tick.
  if (graceTimer) clearTimeout(graceTimer);
  const waiting = view.sessions
    .filter((s) => s.pendingPermission && !s.permissionActionable && !s.permissionAcknowledged)
    .map((s) => PERMISSION_GRACE_MS - (view.now - (s.pendingPermission?.at ?? view.now)));
  if (waiting.length) {
    graceTimer = setTimeout(pushView, Math.max(50, Math.min(...waiting)));
  }

  // Presentation-only: a finished turn collapses back to the pill. This changes
  // the WINDOW, never the status.
  const dismissMs = loadConfig().completedDismissMs;
  if (collapseTimer) clearTimeout(collapseTimer);
  if (dismissMs > 0 && view.active?.status === 'COMPLETED' && loadConfig().expanded) {
    collapseTimer = setTimeout(() => setExpanded(false), dismissMs);
  }
}

// ------------------------------------------------------------------ startup

async function startServers(): Promise<void> {
  const cfg = loadConfig();

  ingest = new IngestServer({
    port: cfg.port,
    token: cfg.token,
    onEvent: (env) => {
      claude.ingest(env);
      const gone = prunable(claude.getState(), Date.now(), SESSION_TTL_MS);
      for (const id of gone) {
        delete acknowledged[id];
        notifier?.forget(id);
      }
      claude.prune(gone);
      pushView();
    },
    onRejected: (reason, remote) => {
      // Logged to the console only, and only the reason -- never the payload.
      console.warn(`[ingest] rejected: ${reason}${remote ? ` from ${remote}` : ''}`);
    },
  });

  try {
    await ingest.listen();
  } catch (err) {
    if (err instanceof PortInUseError) return void portInUse(err.port);
    throw err;
  }

  bridge = new BridgeServer({
    port: cfg.port,
    token: cfg.token,
    onChange: (info) => {
      // Switching to VS Code IS the response to a prompt, whether or not you
      // touched the overlay. Grants are silent, so this is the only timely
      // signal available that you have gone to deal with it.
      if (info.focused) acknowledgeWhereVsCodeIsFocused();
      pushView();
    },
    onRejected: (reason) => console.warn(`[bridge] ${reason}`),
  });
  const raw = ingest.raw();
  if (raw) bridge.attachTo(raw);

  await registry.startAll();
  refreshHookStatus();
}

/**
 * The port is baked into every installed hook, so silently rebinding would
 * orphan all of them. Fail loudly and offer the only two real fixes.
 */
async function portInUse(port: number): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'Agent Watcher: port in use',
    message: `Port ${port} is already in use.`,
    detail:
      `Agent Watcher cannot start on ${port}, and it will not silently move to `
      + `another port: the port is written into your Claude Code hook settings, `
      + `so moving it would leave every installed hook pointing at nothing.\n\n`
      + `Free the port, or pick a new one and reinstall the hooks.`,
    buttons: [`Use port ${port + 1} and reinstall hooks`, 'Quit'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response === 0) {
    const cfg = updateConfig({ port: port + 1 });
    hooks.install('user', cfg.port, cfg.token);
    app.relaunch();
  }
  app.exit(0);
}

/**
 * You are looking at the VS Code window that raised the prompt, so stop shouting.
 *
 * Claude Code fires NOTHING when a permission is granted -- `PreToolUse ->
 * PermissionRequest -> PostToolUse` with silence in between -- so approving in
 * VS Code leaves the bar showing the prompt until the tool finishes, which for a
 * long install is many seconds.
 *
 * This does not claim the prompt was approved, and it does not touch the agent
 * state: it is the same judgement the notifier already makes when it stays quiet
 * because VS Code has focus. `pendingPermission` is still reported in full; it
 * just stops demanding attention you are already giving it. The real state
 * clears when `PostToolUse` actually lands.
 *
 * Requires the VS Code bridge. Without it there is no supported way to know
 * which window has OS focus.
 */
function acknowledgeWhereVsCodeIsFocused(): void {
  for (const s of currentView().sessions) {
    if (s.permissionKey && s.bridge?.focused) acknowledged[s.sessionId] = s.permissionKey;
  }
}

function refreshHookStatus(): void {
  const cfg = loadConfig();
  hookMessage = hooks.overallStatus(cfg.port, cfg.token).message;
}

// --------------------------------------------------------------------- IPC

function registerIpc(): void {
  ipcMain.handle('ui:get-view', () => ({ ...currentView(), expanded: loadConfig().expanded }));
  ipcMain.handle('ui:set-expanded', (_e, expanded: unknown) => {
    setExpanded(Boolean(expanded));
  });
  ipcMain.handle('ui:quit', () => app.quit());

  /**
   * [ok] on the bar. Records "I have seen this prompt" so the bar shrinks and
   * stops shouting. It sends NOTHING to Claude Code -- the session is still
   * WAITING_FOR_PERMISSION, the expanded view still shows the prompt, and you
   * still approve in VS Code. Acknowledging is not approving.
   */
  ipcMain.handle('ui:acknowledge', (_e, sessionId: unknown, key: unknown) => {
    if (typeof sessionId !== 'string' || typeof key !== 'string') return;
    acknowledged[sessionId] = key;
    pushView();
  });

  /**
   * Focus VS Code.
   *
   * NEVER opens a folder. `vscode://file/<dir>` launches a NEW window, which can
   * evict the workspace hosting the session and cancel it -- and the session's
   * `cwd` is very often a SUBFOLDER, which VS Code will not match to an already
   * open workspace. Opening a real FILE instead reuses and raises the window
   * that already has it.
   *
   * Preference order:
   *   1. the bridge's active file (absolute, and definitely in the right window)
   *   2. the last file this session actually touched
   *   3. nothing at all -- a dead button beats a destroyed session
   */
  ipcMain.handle('ui:open-editor', (_e, sessionId: unknown) => {
    const view = currentView();
    const session = typeof sessionId === 'string'
      ? view.sessions.find((s) => s.sessionId === sessionId) ?? view.active
      : view.active;

    // Clicking [Open VS Code] means you are going to handle it there, so the bar
    // stops shouting immediately rather than waiting for the tool to finish.
    // Same semantics as [ok]: acknowledgement, not approval.
    if (session?.permissionKey) {
      acknowledged[session.sessionId] = session.permissionKey;
      setImmediate(pushView);
    }

    // Ask the extension to focus too; it carries no path, so it cannot open anything.
    const viaBridge = bridge?.focusEditor() ?? false;

    const candidate = session?.bridge?.activeFile ?? bridge?.getInfo().activeFile ?? session?.lastFileAbs;
    if (!candidate || !/^([a-zA-Z]:[\\/]|\/)[^\0]*$/.test(candidate)) {
      return { via: viaBridge ? 'bridge' : 'none' };
    }
    // Belt and braces: whatever the path claims to be, only open it if it is a
    // FILE on disk right now. This is the guard that makes the folder bug
    // impossible regardless of where the path came from.
    try {
      if (!statSync(candidate).isFile()) return { via: viaBridge ? 'bridge' : 'none' };
    } catch {
      return { via: viaBridge ? 'bridge' : 'none' };
    }
    void shell.openExternal(`vscode://file/${encodeURI(candidate.replace(/\\/g, '/'))}`);
    return { via: 'file' };
  });

  ipcMain.handle('hooks:status', () => {
    const cfg = loadConfig();
    return { ...hooks.overallStatus(cfg.port, cfg.token), port: cfg.port, url: hookBaseUrl(cfg.port) };
  });
  ipcMain.handle('hooks:install', (_e, scope: unknown) => {
    const cfg = loadConfig();
    const result = hooks.install(scope === 'project' ? 'project' : 'user', cfg.port, cfg.token);
    refreshHookStatus();
    pushView();
    return result;
  });
  ipcMain.handle('hooks:uninstall', (_e, scope: unknown) => {
    const cfg = loadConfig();
    const result = hooks.uninstall(scope === 'project' ? 'project' : 'user', cfg.port);
    refreshHookStatus();
    pushView();
    return result;
  });
}

// ------------------------------------------------------------------- shortcut

function registerShortcut(): void {
  const { shortcut } = loadConfig();
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(shortcut, () => {
    if (!win) {
      win = createWindow();
      return;
    }
    // hidden -> show; expanded -> collapse; visible -> focus.
    if (!win.isVisible()) {
      win.showInactive();
    } else if (loadConfig().expanded) {
      setExpanded(false);
    } else {
      win.show();
      win.focus();
    }
  });
  if (!ok) {
    console.warn(
      `[shortcut] could not register ${shortcut} -- another app already owns it. `
      + 'Change "shortcut" in config.json.',
    );
  }
}

// ----------------------------------------------------------------- lifecycle

// One instance only: a second one would fail to bind the port anyway, and the
// error dialog would be confusing.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    win?.showInactive();
  });

  void app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.agentwatcher.overlay');
    registerIpc();
    win = createWindow();
    await startServers();
    notifier = new Notifier(() => {
      win?.showInactive();
      setExpanded(true);
    });
    registerShortcut();
    setInterval(pushView, VIEW_TICK_MS);
    pushView();
  });

  app.on('window-all-closed', () => {
    // The overlay is the app. Closing it quits, on every platform.
    app.quit();
  });

  app.on('will-quit', async () => {
    globalShortcut.unregisterAll();
    bridge?.close();
    await ingest?.close();
    await registry.stopAll();
  });
}

export { DEFAULT_PORT };
