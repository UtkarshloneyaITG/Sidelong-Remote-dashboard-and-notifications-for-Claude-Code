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

import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BrowserWindow, Menu, Tray, app, dialog, globalShortcut, ipcMain, nativeImage,
  screen, shell,
} from 'electron';
import {
  PERMISSION_GRACE_MS, buildView, hookBaseUrl, prunable,
  type BridgeInfo, type OverlayView,
} from '@agent-watcher/protocol';
import { AdapterRegistry, ClaudeCodeAdapter } from '@agent-watcher/agent-adapters';

import { DEFAULT_PORT, loadConfig, updateConfig } from './config.js';
import { IngestServer, PortInUseError, type Decision } from './ingest.js';
import { BridgeServer } from './bridge-server.js';
import { Notifier } from './notifier.js';
import * as hooks from './hooks-installer.js';

// Set BEFORE anything reads app.getPath('userData'): the package name is scoped
// ("@agent-watcher/desktop") and would otherwise become a nested directory. The
// VS Code bridge looks for the token at this exact folder name.
app.setName('agent-watcher-desktop');

/**
 * The app mark. Windows toasts fall back to the stock Electron icon without it,
 * which is the one place the branding is actually seen -- the overlay window
 * itself is frameless and skips the taskbar.
 */
export const ICON_PATH = join(app.getAppPath(), 'resources', 'icon.png');

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
let tray: Tray | undefined;
let collapseTimer: NodeJS.Timeout | undefined;
let graceTimer: NodeJS.Timeout | undefined;
let hookMessage: string | undefined;
/**
 * sessionId -> the permission key you clicked [ok] on. Lives in MAIN, not the
 * renderer, and is never fed back into the reducer: acknowledging is a display
 * preference, not an agent state change, and it is emphatically not approval.
 */
const acknowledged: Record<string, string> = {};

/**
 * Open PermissionRequest holds, by session.
 *
 * A held request means a tool call is BLOCKED, so nothing may sit in here longer
 * than the configured window -- the ingest server owns that timer and always
 * settles. This map only lets the UI find the right `settle` to call.
 */
interface Hold { settle: (d: Decision) => void; expiresAt: number }
const holds = new Map<string, Hold>();

/** Resolve a held prompt. Idempotent: settle() itself ignores a second call. */
function decide(sessionId: string, behavior: 'allow' | 'deny' | 'defer'): boolean {
  const hold = holds.get(sessionId);
  if (!hold) return false;
  holds.delete(sessionId);
  hold.settle(behavior === 'defer' ? null : { behavior });
  pushView();
  return true;
}

/**
 * How long sessions spent blocked on you, per local day.
 *
 * The reducer accumulates `blockedMs` per session, but sessions are pruned and
 * the app restarts, so the daily figure is banked here by watching each
 * session's counter go up and adding the delta. Kept to 30 days.
 *
 * Local dates on purpose: "today" means your day, not UTC's.
 */
const STATS_KEEP_DAYS = 30;
let blockedByDay: Record<string, number> = {};
const lastBlockedSeen = new Map<string, number>();
let statsDirty = false;

const statsFile = (): string => join(app.getPath('userData'), 'stats.json');
const dayKey = (d = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function loadStats(): void {
  try {
    const raw: unknown = JSON.parse(readFileSync(statsFile(), 'utf8'));
    if (raw && typeof raw === 'object') {
      blockedByDay = Object.fromEntries(
        Object.entries(raw as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'number' && Number.isFinite(v)) as [string, number][],
      );
    }
  } catch {
    /* first run, or a corrupt file we would rather ignore than crash on */
  }
}

/**
 * Flush if anything changed. Called on the view tick as well as on quit, because
 * `will-quit` does not fire on a force-kill or a crash -- and this app is
 * explicitly designed to be killable, so quit-only persistence would silently
 * lose the day's figure exactly when someone exercises that property.
 */
function saveStats(): void {
  if (!statsDirty) return;
  statsDirty = false;
  const keep = Object.keys(blockedByDay).sort().slice(-STATS_KEEP_DAYS);
  blockedByDay = Object.fromEntries(keep.map((k) => [k, blockedByDay[k]]));
  try {
    writeFileSync(statsFile(), JSON.stringify(blockedByDay), 'utf8');
  } catch {
    /* a stat we cannot persist is not worth failing a launch over */
  }
}

/** Fold each session's rising blockedMs into today's total. */
function accrueBlocked(state: { sessions: Record<string, { sessionId: string; blockedMs: number }> }): void {
  const today = dayKey();
  for (const s of Object.values(state.sessions)) {
    const seen = lastBlockedSeen.get(s.sessionId) ?? 0;
    if (s.blockedMs > seen) {
      blockedByDay[today] = (blockedByDay[today] ?? 0) + (s.blockedMs - seen);
      statsDirty = true;
    }
    lastBlockedSeen.set(s.sessionId, s.blockedMs);
  }
}

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
    icon: ICON_PATH,
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
    blockedTodayMs: blockedByDay[dayKey()] ?? 0,
    decisions: Object.fromEntries(
      [...holds].map(([id, h]) => [id, { expiresAt: h.expiresAt }]),
    ),
    acknowledged,
  });
}

function pushView(): void {
  const view = currentView();
  win?.webContents.send('view', { ...view, expanded: loadConfig().expanded });
  notifier?.update(view);
  refreshTray(view);

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
    // Zero disables holding entirely, which is the default.
    decisionWindowMs: cfg.permissionDecisions ? cfg.decisionWindowMs : 0,
    onDecisionRequest: cfg.permissionDecisions
      ? (env, settle, deadline) => {
          const id = env.event.session_id;
          // Already looking at VS Code? Its own prompt is right there and is
          // better than ours, so hand the decision straight back instead of
          // delaying it. This is what stops the feature making things WORSE
          // when you are not using the overlay.
          if (bridge?.getInfo().focused) {
            settle(null);
            return;
          }
          holds.get(id)?.settle(null);   // a newer prompt supersedes an older hold
          holds.set(id, { settle, expiresAt: deadline });
          setImmediate(pushView);
        }
      : undefined,
    onEvent: (env) => {
      debugLog(env);
      claude.ingest(env);
      accrueBlocked(claude.getState());
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

/**
 * Opt-in local diagnostic log: WHICH events arrived and when, never what they
 * contained.
 *
 * Deliberately no payload. `tool_input` carries whole file contents, full command
 * strings and prompt text, and a debug flag is exactly the switch someone leaves
 * on by accident -- so this records only the event name, matcher, tool name and a
 * truncated session id. All of that is structural, none of it is your source.
 *
 * Enable with "debugLog": true in config.json. Written next to it.
 */
function debugLog(env: { event: { hook_event_name?: string; session_id?: string; tool_name?: string }; matcher?: string }): void {
  if (!loadConfig().debugLog) return;
  const e = env.event;
  const line = [
    new Date().toISOString(),
    (e.hook_event_name ?? '?').padEnd(20),
    (env.matcher ?? '-').padEnd(18),
    (e.session_id ?? '?').slice(0, 8),
    e.tool_name ?? '',
  ].join(' ') + '\n';
  try {
    appendFileSync(join(app.getPath('userData'), 'debug.log'), line);
  } catch {
    /* diagnostics must never take the app down */
  }
}

const startsWithWindows = (): boolean => app.getLoginItemSettings().openAtLogin;

/** Short status line for the tray tooltip and its first menu entry. */
function trayLabel(view: OverlayView): string {
  const a = view.active;
  if (!a) return view.ingestReady ? 'No Claude Code session' : 'Receiver down';
  const where = a.project ? `${a.project} — ` : '';
  return `${where}${a.headline}`.slice(0, 110);
}

/**
 * A tray icon, because the overlay sets `skipTaskbar` and has no title bar.
 * Without this there is no way to tell the app is running, and no way to get it
 * back if you hide it other than remembering the global shortcut.
 */
function createTray(): void {
  if (tray) return;
  // Tray art wants ~16px; the source mark is 320px, so downscale explicitly
  // rather than letting Windows do it badly.
  const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Sidelong');
  // Left click is the obvious "bring it back" gesture.
  tray.on('click', () => {
    if (!win) win = createWindow();
    else win.showInactive();
  });
  refreshTray(currentView());
}

function refreshTray(view: OverlayView): void {
  if (!tray) return;
  const label = trayLabel(view);
  tray.setToolTip(`Sidelong — ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    {
      label: 'Show overlay',
      click: () => {
        if (!win) win = createWindow();
        else win.showInactive();
      },
    },
    {
      label: loadConfig().expanded ? 'Minimize to bar' : 'Expand',
      click: () => {
        win?.showInactive();
        setExpanded(!loadConfig().expanded);
      },
    },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: startsWithWindows(),
      // Only meaningful for an installed build: in development this would
      // register the bare electron.exe, which starts nothing useful.
      enabled: app.isPackaged,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath });
        refreshTray(currentView());
      },
    },
    {
      label: hookMessage ? 'Hooks need attention' : 'Hooks installed',
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Quit Sidelong', click: () => app.quit() },
  ]));
}

/** The window the installed hooks must accommodate, or undefined when off. */
function decisionWindow(): number | undefined {
  const cfg = loadConfig();
  return cfg.permissionDecisions ? cfg.decisionWindowMs : undefined;
}

function refreshHookStatus(): void {
  const cfg = loadConfig();
  hookMessage = hooks.overallStatus(cfg.port, cfg.token, decisionWindow()).message;
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
  ipcMain.handle('ui:open-editor', (_e, sessionId: unknown) => openEditorFor(sessionId));

  /**
   * Allow / Deny a held permission prompt.
   *
   * This is the ONE channel in the app that can cause something to run, so it is
   * deliberately narrow: it names no command and carries no path, only which
   * session and which of three fixed verbs. It can only ever answer a request
   * Claude Code is already waiting on, and it does nothing at all unless
   * permissionDecisions is switched on in the config.
   */
  ipcMain.handle('ui:decide', (_e, sessionId: unknown, behavior: unknown) => {
    if (!loadConfig().permissionDecisions) return { ok: false, reason: 'disabled' };
    if (typeof sessionId !== 'string') return { ok: false, reason: 'bad session' };
    if (behavior !== 'allow' && behavior !== 'deny' && behavior !== 'defer') {
      return { ok: false, reason: 'bad behavior' };
    }
    return { ok: decide(sessionId, behavior) };
  });

  ipcMain.handle('hooks:status', () => {
    const cfg = loadConfig();
    return { ...hooks.overallStatus(cfg.port, cfg.token, decisionWindow()), port: cfg.port, url: hookBaseUrl(cfg.port) };
  });
  ipcMain.handle('hooks:install', (_e, scope: unknown) => {
    const cfg = loadConfig();
    const result = hooks.install(scope === 'project' ? 'project' : 'user', cfg.port, cfg.token, undefined, decisionWindow());
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

/**
 * Focus VS Code for a session. Shared by the overlay button and the toast's
 * action button, so both behave identically.
 *
 * NEVER opens a folder. `vscode://file/<dir>` launches a NEW window, which can
 * evict the workspace hosting the session and cancel it -- and the session's
 * `cwd` is very often a SUBFOLDER, which VS Code will not match to an already
 * open workspace. Opening a real FILE instead reuses and raises the window that
 * already has it.
 *
 * Preference order:
 *   1. the bridge's active file (absolute, and definitely in the right window)
 *   2. the last file this session actually touched
 *   3. nothing at all -- a dead button beats a destroyed session
 */
function openEditorFor(sessionId: unknown): { via: string } {
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
    loadStats();
    registerIpc();
    win = createWindow();
    await startServers();
    notifier = new Notifier(() => {
      win?.showInactive();
      setExpanded(true);
    }, (sessionId) => { openEditorFor(sessionId); }, ICON_PATH);
    registerShortcut();
    createTray();
    setInterval(() => {
      pushView();
      saveStats();
    }, VIEW_TICK_MS);
    pushView();
  });

  app.on('window-all-closed', () => {
    // The overlay is the app. Closing it quits, on every platform.
    app.quit();
  });

  app.on('will-quit', async () => {
    saveStats();
    // Hand every held prompt back rather than dying with it open. Claude Code
    // would time out and prompt normally anyway; this just makes it immediate.
    for (const [id] of holds) decide(id, 'defer');
    globalShortcut.unregisterAll();
    tray?.destroy();
    tray = undefined;
    bridge?.close();
    await ingest?.close();
    await registry.stopAll();
  });
}

export { DEFAULT_PORT };
