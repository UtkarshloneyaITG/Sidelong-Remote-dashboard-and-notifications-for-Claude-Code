/**
 * The state model. Everything the overlay can display is defined here, and
 * nothing here is produced by anything except the reducer.
 */

export type Status =
  | 'IDLE'
  | 'WORKING'
  | 'WAITING_FOR_PERMISSION'
  | 'WAITING_FOR_INPUT'
  | 'COMPLETED'
  | 'ERROR'
  | 'DISCONNECTED'
  | 'UNKNOWN';

export type Severity = 'neutral' | 'active' | 'attention' | 'success' | 'error' | 'offline';

/**
 * Single source of truth for status -> severity, so the UI cannot drift from the
 * state machine. The renderer reads `severity`; it never maps status itself.
 */
const SEVERITY: Record<Status, Severity> = {
  IDLE: 'neutral',
  WORKING: 'active',
  WAITING_FOR_PERMISSION: 'attention',
  WAITING_FOR_INPUT: 'attention',
  COMPLETED: 'success',
  ERROR: 'error',
  DISCONNECTED: 'offline',
  UNKNOWN: 'neutral',
};

export const severityOf = (status: Status): Severity => SEVERITY[status] ?? 'neutral';

/**
 * How long a permission prompt must SURVIVE before it counts as real.
 *
 * `PermissionRequest` fires even when the request is about to be auto-approved;
 * the approval lands milliseconds later and the prompt clears. Without this
 * grace period that flicker fired a desktop notification, which then sat on
 * screen telling you to open VS Code for a command that had already run.
 *
 * Keyed on survival rather than on `permission_mode`, because mode is not a
 * reliable proxy: `acceptEdits` auto-approves edits but still genuinely prompts
 * for Bash, and suppressing those would hide the single state this app exists
 * for. A real prompt waits for a human and sails past this threshold; an
 * auto-approved one never reaches it.
 *
 * Lives here rather than in view.ts so the reducer can use it too -- it decides
 * which prompts count toward blocked time -- without a circular import.
 * Well under the "surface it in one second" bar.
 */
export const PERMISSION_GRACE_MS = 700;

export type ActivityStatus = 'running' | 'done' | 'failed';

export interface Activity {
  id: string;
  tool: string;
  /** Human display line, e.g. "Editing src/App.tsx". Never invented -- see describeTool. */
  label: string;
  status: ActivityStatus;
  startedAt: number;
  endedAt?: number;
  /** Set when the call came from a subagent, so it cannot masquerade as top-level. */
  agentType?: string;
  /** Populated by PostToolUseFailure. */
  error?: string;
}

export interface PendingPermission {
  tool: string;
  /** e.g. "Run `npm install`?" -- built from real tool_input, truncated. */
  detail: string;
  at: number;
  /** PermissionRequest is primary; Notification is the corroborating backstop. */
  source: 'PermissionRequest' | 'Notification';
}

export interface SessionState {
  sessionId: string;
  status: Status;
  /** The headline. "Claude is working…" when the tool/target is unknown. */
  message: string;
  details?: string;
  workspace?: string;
  model?: string;
  permissionMode?: string;
  /** When this state was produced, from the event that produced it. */
  timestamp: number;
  /** When the session last emitted ANY event. Drives staleness and recency. */
  lastActivityAt: number;
  /** Set by UserPromptSubmit; the elapsed clock origin. */
  turnStartedAt?: number;
  /** Frozen at Stop/StopFailure; otherwise computed live from turnStartedAt. */
  elapsedMs: number;
  activity: Activity[];
  filesChanged: string[];
  /**
   * ABSOLUTE path of the last file Claude touched in this session.
   *
   * Kept for exactly one reason: focusing VS Code. Opening a FILE via
   * `vscode://file/...` reuses (and raises) the window that already has it,
   * whereas opening a FOLDER launches a new window and can evict the workspace
   * hosting the session. `workspace` (the cwd) is a directory and must never be
   * used for that, so we keep a real file too.
   */
  lastFileAbs?: string;
  pendingPermission?: PendingPermission;
  error?: { kind: string; detail: string };
  /**
   * Total time this session has spent genuinely blocked on a permission prompt,
   * accumulated across turns. Only prompts that outlived PERMISSION_GRACE_MS
   * count — an auto-approved one never waited on you.
   *
   * This is the one number that measures the problem the app exists to solve,
   * and nothing else can compute it.
   */
  blockedMs: number;
  /** Count of subagents currently running. */
  subagents: number;
  /** True while a context compaction is in flight -- explains a long silence. */
  compacting: boolean;
}

export interface WatcherState {
  sessions: Record<string, SessionState>;
  /** Session that most recently emitted an event. */
  activeSessionId?: string;
}

export const initialState: WatcherState = { sessions: {} };

/** Statuses that mean the session is finished with its turn. */
export const isTerminal = (s: Status): boolean =>
  s === 'COMPLETED' || s === 'ERROR' || s === 'DISCONNECTED';

/** Statuses that should raise a desktop notification (spec section 7). */
export const shouldNotify = (s: Status): boolean =>
  s === 'WAITING_FOR_PERMISSION' || s === 'WAITING_FOR_INPUT' || s === 'COMPLETED' || s === 'ERROR';
