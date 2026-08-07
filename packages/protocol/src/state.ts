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
