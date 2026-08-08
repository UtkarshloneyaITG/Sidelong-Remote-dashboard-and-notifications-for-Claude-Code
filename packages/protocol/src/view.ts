/**
 * The view model. The renderer receives ONE of these and renders it -- it holds
 * no agent state of its own and there is no path by which a UI interaction can
 * change a displayed status (spec section 10).
 *
 * Built in exactly one place so `severity` can never drift from `status`.
 */

import { PERMISSION_GRACE_MS, severityOf } from './state.js';
import type { Activity, SessionState, Severity, Status, WatcherState } from './state.js';
import { isStale } from './reducer.js';

export type BridgeStatus = 'connected' | 'reconnecting' | 'disconnected';

/** Enrichment from the VS Code extension. Optional by design: absent is normal. */
export interface BridgeInfo {
  status: BridgeStatus;
  workspaceFolders?: string[];
  activeFile?: string;
  language?: string;
  gitBranch?: string;
  /** Whether the VS Code window has OS focus -- used to suppress notifications. */
  focused?: boolean;
  diagnostics?: { errors: number; warnings: number };
  lastSeenAt?: number;
}

export interface SessionView {
  sessionId: string;
  status: Status;
  severity: Severity;
  /** The raw status message from the reducer. Prefer `headline` for display. */
  message: string;
  /** What Claude is actually doing — see headlineOf. This is what the UI shows. */
  headline: string;
  /** True when `headline` is a concrete command/file, so the UI can style it as one. */
  headlineIsCommand: boolean;
  details?: string;
  workspace?: string;
  /** Just the folder name, for the pill. */
  project?: string;
  model?: string;
  permissionMode?: string;
  elapsedMs: number;
  /** Non-null while WORKING so the renderer can tick a clock without inventing one. */
  turnStartedAt?: number;
  activity: Activity[];
  filesChanged: string[];
  /** Absolute path of a real FILE, for safely focusing VS Code. Never a folder. */
  lastFileAbs?: string;
  pendingPermission?: SessionState['pendingPermission'];
  /** Stable id for one permission prompt, so "seen it" survives a re-render. */
  permissionKey?: string;
  /**
   * You clicked [ok] on this exact prompt. PRESENTATION ONLY -- `status` is
   * still WAITING_FOR_PERMISSION and the expanded view still shows it. Nothing
   * is sent to Claude Code; acknowledging is not approving.
   */
  permissionAcknowledged: boolean;
  /**
   * The prompt is real, has outlived PERMISSION_GRACE_MS, and you have not
   * acknowledged it. ONLY this may show buttons or raise a notification.
   * `pendingPermission` alone must not -- it flickers on auto-approval.
   */
  permissionActionable: boolean;
  /**
   * Claude is running tools under an auto-approving permission mode. Shown as
   * context; it is deliberately NOT what gates the buttons (see
   * PERMISSION_GRACE_MS).
   */
  autoRunning: boolean;
  error?: SessionState['error'];
  /** Time this session genuinely spent waiting on you. See SessionState.blockedMs. */
  blockedMs: number;
  subagents: number;
  compacting: boolean;
  stale: boolean;
  lastActivityAt: number;
  /** The VS Code window whose workspace matches this session's cwd, if any. */
  bridge?: BridgeInfo;
}

export interface OverlayView {
  protocolVersion: number;
  /** The session shown in the collapsed pill. */
  active?: SessionView;
  /** Every live session, most recently active first. */
  sessions: SessionView[];
  /** How many sessions besides `active` -- renders as the "+2" badge. */
  otherSessions: number;
  bridge: BridgeInfo;
  /** True once the hook receiver is listening. */
  ingestReady: boolean;
  /** Set when the installed hook config no longer matches this app's port/token. */
  hookConfigDrift?: string;
  /**
   * Total time today that sessions spent blocked waiting on you, accumulated by
   * the main process across sessions and restarts. The one number that measures
   * the problem this app exists to solve.
   */
  blockedTodayMs?: number;
  now: number;
}

const projectName = (cwd?: string): string | undefined =>
  cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || undefined;

/**
 * Match a session to a VS Code window by comparing the hook's `cwd` against the
 * workspace folders the bridge reported. Case-insensitive and separator-agnostic
 * because Windows hands us `D:\x` from one source and `d:/x` from the other.
 */
export function bridgeMatches(cwd: string | undefined, bridge: BridgeInfo): boolean {
  if (!cwd || !bridge.workspaceFolders?.length) return false;
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const c = norm(cwd);
  return bridge.workspaceFolders.some((f) => {
    const w = norm(f);
    return c === w || c.startsWith(w + '/');
  });
}

/** Permission modes in which Claude runs at least some tools without prompting. */
const AUTO_MODES = new Set(['acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);

// PERMISSION_GRACE_MS now lives in state.ts, because the reducer needs it to
// decide which prompts count toward blocked time. Re-exported from the package
// root via index.ts, so importers are unaffected.

export const permissionKeyOf = (s: SessionState): string | undefined =>
  s.pendingPermission ? `${s.pendingPermission.tool}:${s.pendingPermission.at}` : undefined;

/**
 * The one line that says what Claude is ACTUALLY doing.
 *
 * "Claude needs your attention" is a state label, not information -- and it used
 * to be all you got once a prompt was acknowledged or still inside its grace
 * window. This always prefers the most concrete real thing known:
 *
 *   1. the pending command itself      `Run \`npm install\`?`
 *   2. the tool running right now      `Reading src/app.ts`
 *   3. compaction                      `Compacting context…`
 *   4. a turn in flight, no tool       `Thinking…`
 *   5. the status message              summary / error / `Ready`
 *
 * `Thinking…` is a derivation, not a guess: the turn is open (`turnStartedAt`)
 * and no tool call is running, which is exactly the gap where Claude is talking
 * to the model. No hook fires during inference, so this is the honest name for
 * an interval we can bound but not see into.
 */
/** "3m" / "45s" / "1h 4m" — a gap you read, not parse. */
export function humanGap(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

export function headlineOf(s: SessionState): string {
  if (s.pendingPermission) return s.pendingPermission.detail;
  const running = [...s.activity].reverse().find((a) => a.status === 'running');
  if (running) return running.label;
  if (s.compacting) return 'Compacting context…';
  if (s.status === 'WORKING') return 'Thinking…';
  return s.message;
}

export function toSessionView(
  s: SessionState,
  now: number,
  staleMs: number,
  bridge: BridgeInfo,
  acknowledgedKey?: string,
): SessionView {
  const terminal = s.status === 'COMPLETED' || s.status === 'ERROR' || s.status === 'DISCONNECTED';
  const permissionKey = permissionKeyOf(s);
  const toolRunning = s.activity.some((a) => a.status === 'running');
  const stale = isStale(s, now, staleMs);

  /**
   * Interrupting Claude Code fires NOTHING -- measured, not assumed: over 168
   * captured events, three of six turns ended with no event whatsoever, and one
   * tool call produced a PreToolUse with no PostToolUse or PostToolUseFailure.
   * So an interrupt is undetectable and the bar would otherwise keep asserting
   * "Thinking…" or a tool line indefinitely.
   *
   * We cannot say it stopped. We CAN stop claiming it is still working, and say
   * exactly what we know: how long it has been since anything arrived.
   *
   * Only when no tool is running. Silence during a tool call is completely
   * normal -- a long build emits nothing between PreToolUse and PostToolUse --
   * whereas silence with nothing running is model inference, which does not
   * legitimately run for minutes.
   */
  const headline = stale && !toolRunning && s.status === 'WORKING' && !s.pendingPermission
    ? `No events for ${humanGap(now - s.lastActivityAt)}`
    : headlineOf(s);

  return {
    sessionId: s.sessionId,
    status: s.status,
    severity: severityOf(s.status),
    message: s.message,
    headline,
    headlineIsCommand: Boolean(s.pendingPermission || toolRunning),
    details: s.details,
    workspace: s.workspace,
    project: projectName(s.workspace),
    model: s.model,
    permissionMode: s.permissionMode,
    // Frozen once the turn is over; live otherwise.
    elapsedMs: terminal || !s.turnStartedAt ? s.elapsedMs : now - s.turnStartedAt,
    turnStartedAt: terminal ? undefined : s.turnStartedAt,
    activity: s.activity,
    filesChanged: s.filesChanged,
    lastFileAbs: s.lastFileAbs,
    pendingPermission: s.pendingPermission,
    permissionKey,
    permissionAcknowledged: Boolean(permissionKey && permissionKey === acknowledgedKey),
    permissionActionable: Boolean(
      s.pendingPermission
      && permissionKey !== acknowledgedKey
      && now - s.pendingPermission.at >= PERMISSION_GRACE_MS,
    ),
    autoRunning: s.status === 'WORKING' && AUTO_MODES.has(s.permissionMode ?? ''),
    error: s.error,
    blockedMs: s.blockedMs,
    subagents: s.subagents,
    compacting: s.compacting,
    stale,
    lastActivityAt: s.lastActivityAt,
    bridge: bridgeMatches(s.workspace, bridge) ? bridge : undefined,
  };
}

export function buildView(
  state: WatcherState,
  opts: {
    now: number;
    staleMs: number;
    bridge: BridgeInfo;
    ingestReady: boolean;
    hookConfigDrift?: string;
    /** sessionId -> the permission key you already clicked [ok] on. */
    acknowledged?: Record<string, string>;
    /** Today's blocked-on-you total, banked by the main process. */
    blockedTodayMs?: number;
  },
): OverlayView {
  const sessions = Object.values(state.sessions)
    .map((s) => toSessionView(s, opts.now, opts.staleMs, opts.bridge, opts.acknowledged?.[s.sessionId]))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);

  // A session genuinely blocked on permission outranks recency -- it is the whole
  // point of the app, and it must not hide behind a chattier session in another
  // window. Uses `permissionActionable`, so a prompt that is about to be
  // auto-approved never yanks the pill away from what you were watching.
  const blocked = sessions.filter((s) => s.permissionActionable);
  const active = blocked[0] ?? sessions.find((s) => s.status === 'WAITING_FOR_PERMISSION') ?? sessions[0];

  return {
    protocolVersion: 1,
    active,
    sessions,
    otherSessions: Math.max(0, sessions.length - 1),
    bridge: opts.bridge,
    ingestReady: opts.ingestReady,
    hookConfigDrift: opts.hookConfigDrift,
    blockedTodayMs: opts.blockedTodayMs,
    now: opts.now,
  };
}
