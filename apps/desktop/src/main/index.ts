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
  PERMISSION_GRACE_MS, buildView, commandKey, hookBaseUrl, prunable,
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
const BAR_HEIGHT = 56;
/**
 * Resize limits per mode.
 *
 * The capsule resizes HORIZONTALLY ONLY -- its height is locked, because a taller
 * capsule is just a broken capsule, while a wider one genuinely shows more of the
 * command. The expanded card resizes on both axes.
 */
const BAR_MIN_WIDTH = 360;
const BAR_MAX_WIDTH = 1600;
const EXPANDED_MIN = { width: 300, height: 240 };
const EXPANDED_MAX = { width: 1200, height: 1200 };
/** Content size for a mode, honouring whatever you last dragged it to. */
function modeSize(expanded: boolean): { width: number; height: number } {
  const cfg = loadConfig();
  return expanded
    ? { width: cfg.expandedSize.width, height: cfg.expandedSize.height }
    : { width: cfg.barWidth, height: BAR_HEIGHT };
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.round(Math.min(hi, Math.max(lo, v)));

/**
 * Apply a resize asked for by a renderer grip, clamped to what the mode allows.
 *
 * The capsule takes width only and keeps its RIGHT edge anchored, because it
 * lives in the top-right corner -- growing rightwards would walk it off screen.
 * The card takes both axes and grows down-right from its top-left, which is what
 * a bottom-right corner grip should do.
 */
/** The screen edge that must not move, captured once when the drag started. */
type Anchor = { side: 'left' | 'right'; x: number };

function resizeTo(width: number, height: number, anchor?: Anchor): void {
  if (!win) return;
  if (loadConfig().expanded) {
    const w = clamp(width, EXPANDED_MIN.width, EXPANDED_MAX.width);
    const h = clamp(height, EXPANDED_MIN.height, EXPANDED_MAX.height);
    win.setContentSize(w, h);
    updateConfig({ expandedSize: { width: w, height: h } });
    return;
  }
  const w = clamp(width, BAR_MIN_WIDTH, BAR_MAX_WIDTH);
  const b = win.getBounds();
  // One setBounds, not setContentSize followed by setPosition: a drag calls this
  // dozens of times, and the rounding between two separate calls accumulates into
  // visible drift. The window is frameless, so bounds and content size are the
  // same rectangle.
  //
  // The anchor is the coordinate the RENDERER read once at pointerdown, not one
  // derived from the current bounds -- re-deriving it every move feeds each
  // frame's rounding into the next and the "fixed" edge crawls across the screen.
  const x = anchor ? (anchor.side === 'right' ? anchor.x - w : anchor.x) : b.x;
  win.setBounds({ x, y: b.y, width: w, height: BAR_HEIGHT });
  updateConfig({ barWidth: w });
}
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

  // Answering IS dealing with it. Without this the prompt stays "actionable"
  // until PostToolUse lands, so the acknowledge pair would pop up the instant
  // Allow was clicked -- offering to remind you about something you just decided.
  if (behavior !== 'defer') {
    const s = currentView().sessions.find((x) => x.sessionId === sessionId);
    if (s?.permissionKey) {
      acknowledged[sessionId] = s.permissionKey;
      // Stamp the wait NOW, at the click. This is the sample that gets compared
      // against the ones resolved in VS Code; the tally itself happens when the
      // prompt clears, so a prompt cannot be counted in both populations.
      const id = promptId(sessionId, s.permissionKey);
      if (s.pendingPermission) answeredInBar.set(id, Math.max(0, Date.now() - s.pendingPermission.at));
    }
  }
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

/**
 * Per-day counts, alongside the blocked total.
 *
 * Every one of these is a tally of something that actually arrived. There is
 * deliberately no "time saved" figure: that would be a counterfactual -- what
 * your day would have looked like without the overlay -- and this app does not
 * invent numbers it cannot observe. `answered` is the closest honest thing to
 * it, being an exact count of prompts you settled from the bar and therefore did
 * not switch windows for.
 */
export interface DayCounts {
  /** Permission prompts that survived the grace period and were shown to you. */
  prompts: number;
  /** Of those, ones you answered from the bar with Allow or Deny. */
  answered: number;
  /** Total wait across those, measured to the instant you clicked. */
  answeredMs: number;
  /** Prompts that cleared without you touching the bar -- answered in VS Code. */
  elsewhere: number;
  /** Total wait across those. */
  elsewhereMs: number;
  /** Tool calls started. */
  tools: number;
  /** Turns that ended. */
  turns: number;
  /** Sessions started. */
  sessions: number;
}

const ZERO_COUNTS: DayCounts = {
  prompts: 0, answered: 0, answeredMs: 0, elsewhere: 0, elsewhereMs: 0,
  tools: 0, turns: 0, sessions: 0,
};
let countsByDay: Record<string, DayCounts> = {};

/**
 * day -> `commandKey` -> how many prompts asked about it.
 *
 * Answers "what does Claude keep asking me about", which is the one statistic
 * here you can act on: what shows up repeatedly belongs in your allowlist, and
 * then it stops interrupting you. See `commandKey` for why only a program name
 * and at most one subcommand are ever written down.
 */
let commandsByDay: Record<string, Record<string, number>> = {};

function bumpCommand(key: string): void {
  const day = dayKey();
  const row = commandsByDay[day] ?? {};
  row[key] = (row[key] ?? 0) + 1;
  commandsByDay[day] = row;
  statsDirty = true;
}

function bump(field: keyof DayCounts, by = 1): void {
  const day = dayKey();
  const row = countsByDay[day] ?? { ...ZERO_COUNTS };
  row[field] += by;
  countsByDay[day] = row;
  statsDirty = true;
}

/**
 * Count a prompt once, using the SAME gate the bar uses to show one.
 *
 * Counting raw `PermissionRequest` events would inflate this with prompts that
 * were auto-approved milliseconds later and never reached you -- the exact
 * flicker `permissionActionable` exists to suppress. A number that disagrees
 * with what you saw is worse than no number.
 */
const openPrompts = new Map<string, number>(); // id -> when it arrived
const answeredInBar = new Map<string, number>(); // id -> wait at the moment of the click

const promptId = (sessionId: string, key: string): string => `${sessionId}:${key}`;

function accruePrompts(view: {
  now: number;
  sessions: {
    sessionId: string;
    permissionActionable?: boolean;
    permissionKey?: string;
    pendingPermission?: { at: number; tool?: string; detail: string };
  }[];
}): void {
  const live = new Set<string>();
  for (const s of view.sessions) {
    if (!s.pendingPermission || !s.permissionKey) continue;
    const id = promptId(s.sessionId, s.permissionKey);
    live.add(id);
    if (!openPrompts.has(id) && s.permissionActionable) {
      openPrompts.set(id, s.pendingPermission.at);
      bump('prompts');
      bumpCommand(commandKey(s.pendingPermission.tool, s.pendingPermission.detail));
    }
  }

  // A prompt that is no longer pending got resolved. HOW it was resolved is the
  // measurement: from the bar, or somewhere we cannot see.
  for (const [id, at] of openPrompts) {
    if (live.has(id)) continue;
    const clicked = answeredInBar.get(id);
    if (clicked === undefined) {
      // Nobody touched the bar, so this was granted in VS Code or the terminal.
      // Permission grants fire no hook -- measured -- so the first evidence is
      // the tool RUNNING, a few tens of ms after the human actually clicked.
      // That overstates this population's wait, which flatters the bar: the
      // saving is computed as (this mean - the bar's mean). Tens of ms against
      // waits measured in seconds, but the direction is stated in the panel
      // rather than left for someone to work out.
      bump('elsewhere');
      bump('elsewhereMs', Math.max(0, view.now - at));
    } else {
      bump('answered');
      bump('answeredMs', clicked);
    }
    openPrompts.delete(id);
    answeredInBar.delete(id);
  }
}

const statsFile = (): string => join(app.getPath('userData'), 'stats.json');
const dayKey = (d = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Reads both shapes. Before counts existed the file WAS the blocked map, and an
 * upgrade must not throw away the days someone has already banked.
 */
function loadStats(): void {
  try {
    const raw: unknown = JSON.parse(readFileSync(statsFile(), 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    const obj = raw as Record<string, unknown>;
    const legacy = !('blockedByDay' in obj) && !('countsByDay' in obj);
    const blocked = legacy ? obj : obj.blockedByDay;
    if (blocked && typeof blocked === 'object') {
      blockedByDay = Object.fromEntries(
        Object.entries(blocked as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'number' && Number.isFinite(v)) as [string, number][],
      );
    }
    if (obj.countsByDay && typeof obj.countsByDay === 'object') {
      countsByDay = Object.fromEntries(
        Object.entries(obj.countsByDay as Record<string, unknown>)
          .filter(([, v]) => v && typeof v === 'object')
          .map(([k, v]) => [k, { ...ZERO_COUNTS, ...(v as Partial<DayCounts>) }]),
      );
    }
    if (obj.commandsByDay && typeof obj.commandsByDay === 'object') {
      commandsByDay = Object.fromEntries(
        Object.entries(obj.commandsByDay as Record<string, unknown>)
          .filter(([, v]) => v && typeof v === 'object')
          .map(([day, v]) => [day, Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([, n]) => typeof n === 'number' && Number.isFinite(n)) as [string, number][],
          )]),
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
  const keepCounts = Object.keys(countsByDay).sort().slice(-STATS_KEEP_DAYS);
  countsByDay = Object.fromEntries(keepCounts.map((k) => [k, countsByDay[k]]));
  const keepCmds = Object.keys(commandsByDay).sort().slice(-STATS_KEEP_DAYS);
  commandsByDay = Object.fromEntries(keepCmds.map((k) => [k, commandsByDay[k]]));
  try {
    writeFileSync(statsFile(), JSON.stringify({ blockedByDay, countsByDay, commandsByDay }), 'utf8');
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
  const size = modeSize(cfg.expanded);
  const area = screen.getPrimaryDisplay().workArea;

  const w = new BrowserWindow({
    ...size,
    icon: ICON_PATH,
    x: cfg.bounds?.x ?? area.x + area.width - size.width - 24,
    y: cfg.bounds?.y ?? area.y + 24,
    frame: false,
    transparent: true,
    // A TRANSPARENT frameless window gets no OS resize border on Windows --
    // measured: WS_THICKFRAME is absent whatever this is set to, in both modes.
    // Native drag-resize and rounded corners are mutually exclusive, so resizing
    // is done with grips in the renderer calling `ui:resize`, and the limits are
    // enforced in main rather than by the window.
    resizable: false,
    // Size the CONTENT, not the window rect: a frameless window on Windows still
    // carries an invisible border, and without this the card ends up a few pixels
    // short of what the layout expects.
    useContentSize: true,
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
  // Remember what you dragged it to, per mode -- otherwise the next toggle would
  // silently throw the resize away.
  w.on('resized', () => {
    const [cw, ch] = w.getContentSize();
    if (loadConfig().expanded) updateConfig({ expandedSize: { width: cw, height: ch } });
    else updateConfig({ barWidth: cw });
    saveBounds(w);
  });
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
  const size = modeSize(expanded);
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
  accruePrompts(view);
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
    // Drop the buttons the moment the request is gone, however it went.
    onDecisionClosed: (sessionId) => {
      if (holds.delete(sessionId)) setImmediate(pushView);
    },
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
      // Tallies, from the event that actually arrived -- not from a state we
      // inferred afterwards. `prompts` is counted from the view instead, so it
      // matches what was put in front of you rather than what was requested.
      if (env.event.hook_event_name === 'PreToolUse') bump('tools');
      else if (env.event.hook_event_name === 'Stop') bump('turns');
      else if (env.event.hook_event_name === 'SessionStart') bump('sessions');
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
   * A resize grip was dragged. Geometry only -- it cannot touch agent state.
   * Limits are enforced here rather than by the window, because a transparent
   * window has no OS resize border to enforce them.
   */
  /**
   * The stats panel's data: one row per local day, oldest first, with gaps
   * filled in as real zeroes. A day you did not use Claude Code is a zero, not
   * a missing bar -- dropping it would quietly redraw the x axis and make a
   * quiet week look identical to a busy one.
   */
  ipcMain.handle('ui:stats', () => {
    const days: {
      date: string; blockedMs: number; counts: DayCounts; commands: Record<string, number>;
    }[] = [];
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (STATS_KEEP_DAYS - 1));
    for (let i = 0; i < STATS_KEEP_DAYS; i += 1) {
      const key = dayKey(d);
      days.push({
        date: key,
        blockedMs: blockedByDay[key] ?? 0,
        counts: countsByDay[key] ?? { ...ZERO_COUNTS },
        commands: commandsByDay[key] ?? {},
      });
      d.setDate(d.getDate() + 1);
    }
    return { days };
  });

  ipcMain.handle('ui:resize', (_e, width: unknown, height: unknown, anchor: unknown) => {
    if (typeof width !== 'number' || typeof height !== 'number') return;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    const a = anchor as Partial<Anchor> | undefined;
    const valid =
      a != null &&
      (a.side === 'left' || a.side === 'right') &&
      typeof a.x === 'number' &&
      Number.isFinite(a.x);
    resizeTo(width, height, valid ? (a as Anchor) : undefined);
  });

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
