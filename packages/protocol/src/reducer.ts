/**
 * THE PRODUCT.
 *
 * A pure `(state, event) -> state` function. No I/O, no timers, no Date.now(),
 * no Electron imports. Every state the overlay can ever display is produced
 * here, from an event that was actually received. Nothing else in this repo is
 * allowed to author a status.
 *
 * `now` is carried on the envelope (`receivedAt`) rather than read from the
 * clock, which is what keeps this testable and replayable: the same fixture
 * stream always produces the same state sequence.
 */

import type { HookEvent, IngestEnvelope } from './events.js';
import {
  MAX_DETAIL, MAX_MESSAGE, absoluteFile, changedFile, describePermission, describeTool, truncate,
} from './describe.js';
import { PERMISSION_GRACE_MS } from './state.js';
import type { Activity, SessionState, Status, WatcherState } from './state.js';

const MAX_ACTIVITY = 50;
const MAX_FILES = 100;

/** Human labels for the StopFailure matchers, which are the real error classes. */
const ERROR_LABELS: Record<string, string> = {
  rate_limit: 'Rate limited',
  overloaded: 'API overloaded',
  authentication_failed: 'Authentication failed',
  oauth_org_not_allowed: 'Organization not allowed',
  billing_error: 'Billing problem',
  invalid_request: 'Invalid request',
  model_not_found: 'Model not found',
  server_error: 'Server error',
  max_output_tokens: 'Hit max output tokens',
  unknown: 'Claude Code reported a failure',
};

function blankSession(sessionId: string, now: number): SessionState {
  return {
    sessionId,
    status: 'UNKNOWN',
    message: 'Waiting for Claude…',
    timestamp: now,
    lastActivityAt: now,
    elapsedMs: 0,
    activity: [],
    filesChanged: [],
    blockedMs: 0,
    subagents: 0,
    compacting: false,
  };
}

/** Common per-event bookkeeping applied before the event-specific transition. */
function touch(s: SessionState, e: HookEvent, now: number): SessionState {
  return {
    ...s,
    timestamp: now,
    lastActivityAt: now,
    workspace: e.cwd ?? s.workspace,
    permissionMode: e.permission_mode ?? s.permissionMode,
    model: e.model ?? s.model,
    elapsedMs: s.turnStartedAt ? now - s.turnStartedAt : s.elapsedMs,
  };
}

const pushActivity = (list: Activity[], a: Activity): Activity[] =>
  [...list, a].slice(-MAX_ACTIVITY);

function closeActivity(
  list: Activity[],
  id: string | undefined,
  toolName: string | undefined,
  status: 'done' | 'failed',
  now: number,
  error?: string,
): Activity[] {
  // Match on tool_use_id when we have one. Falling back to "the most recent
  // still-running call of this tool" matters because not every event carries an
  // id -- without it a PostToolUseFailure would silently leave a spinner running.
  let idx = id ? list.findIndex((a) => a.id === id) : -1;
  if (idx === -1) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].status === 'running' && (!toolName || list[i].tool === toolName)) {
        idx = i;
        break;
      }
    }
  }
  if (idx === -1) return list;
  const next = [...list];
  next[idx] = { ...next[idx], status, endedAt: now, error };
  return next;
}

const addFile = (files: string[], f: string | undefined): string[] =>
  !f || files.includes(f) ? files : [...files, f].slice(-MAX_FILES);

/**
 * Bank the time an outstanding prompt spent waiting on a human.
 *
 * Called from EVERY path that clears `pendingPermission`, so the total cannot
 * drift depending on how a prompt happened to end. Prompts resolved inside the
 * grace window are ignored: they were auto-approved and never actually blocked
 * you, and counting them would inflate the one metric that is supposed to be
 * trustworthy.
 *
 * A prompt that never resolves at all (you interrupted the turn — no hook fires)
 * contributes nothing. Under-counting is the right direction to be wrong in.
 */
function settleBlocked(s: SessionState, now: number): number {
  const p = s.pendingPermission;
  if (!p) return s.blockedMs;
  const held = now - p.at;
  return held >= PERMISSION_GRACE_MS ? s.blockedMs + held : s.blockedMs;
}

/**
 * Clear a pending prompt because the session has demonstrably moved on.
 *
 * Returns an empty patch when nothing was pending, so callers can spread it
 * unconditionally without disturbing a session that was never blocked.
 */
function unblocked(s: SessionState, now: number): Partial<SessionState> {
  if (!s.pendingPermission) return {};
  return {
    pendingPermission: undefined,
    blockedMs: settleBlocked(s, now),
    status: s.status === 'WAITING_FOR_PERMISSION' ? 'WORKING' : s.status,
    message: s.status === 'WAITING_FOR_PERMISSION' ? 'Claude is working…' : s.message,
  };
}

/** Start of a new turn: drop the previous turn's outcome, keep the session. */
function beginTurn(s: SessionState, now: number, message: string): SessionState {
  return {
    ...s,
    status: 'WORKING',
    message,
    details: undefined,
    error: undefined,
    pendingPermission: undefined,
    // Accumulates across turns; a new prompt does not wipe what you already lost.
    blockedMs: settleBlocked(s, now),
    turnStartedAt: now,
    elapsedMs: 0,
    activity: [],
    filesChanged: [],
    compacting: false,
  };
}

function reduceSession(s: SessionState, env: IngestEnvelope): SessionState {
  const e = env.event;
  const now = env.receivedAt;
  const m = env.matcher;
  const cwd = e.cwd ?? s.workspace;
  const base = touch(s, e, now);
  // A tool call made BY a subagent must not overwrite the top-level headline.
  const isSubagent = Boolean(e.agent_id ?? e.agent_type);

  switch (e.hook_event_name) {
    case 'SessionStart':
      return {
        ...base,
        status: 'IDLE',
        message: m === 'resume' ? 'Session resumed' : 'Ready',
        details: undefined,
        error: undefined,
        pendingPermission: undefined,
        turnStartedAt: undefined,
        elapsedMs: 0,
        activity: [],
        filesChanged: [],
        // A fresh session starts its own tally.
        blockedMs: 0,
        subagents: 0,
        compacting: false,
      };

    case 'UserPromptSubmit':
      return beginTurn(base, now, 'Claude is working…');

    case 'PreToolUse': {
      const label = describeTool(e.tool_name, e.tool_input, cwd)
        ?? (e.tool_name ? `Using ${e.tool_name}` : 'Claude is working…');
      const activity = pushActivity(base.activity, {
        id: e.tool_use_id ?? `${e.tool_name ?? 'tool'}-${now}`,
        tool: e.tool_name ?? 'unknown',
        label,
        status: 'running',
        startedAt: now,
        agentType: e.agent_type,
      });
      return {
        ...base,
        // A PreToolUse can arrive without a preceding UserPromptSubmit (resumed
        // session, /compact). Starting the clock here keeps elapsed honest.
        status: 'WORKING',
        turnStartedAt: base.turnStartedAt ?? now,
        message: isSubagent ? base.message : label,
        pendingPermission: undefined,
        blockedMs: settleBlocked(base, now),
        activity,
        lastFileAbs: absoluteFile(e.tool_input) ?? base.lastFileAbs,
      };
    }

    case 'PostToolUse': {
      const activity = closeActivity(base.activity, e.tool_use_id, e.tool_name, 'done', now);
      return {
        ...base,
        status: base.status === 'WAITING_FOR_PERMISSION' ? 'WORKING' : base.status,
        pendingPermission: undefined,
        blockedMs: settleBlocked(base, now),
        activity,
        filesChanged: addFile(base.filesChanged, changedFile(e.tool_name, e.tool_input, cwd)),
        lastFileAbs: absoluteFile(e.tool_input) ?? base.lastFileAbs,
      };
    }

    case 'PostToolUseFailure': {
      // An interrupt is the user pressing Esc, not a failure. Painting it red
      // would report the user's own action back to them as an error.
      // The tool call is over either way, so a permission prompt for it cannot
      // still be outstanding. Without this a prompt ended by Esc (or by the call
      // failing) left the session stuck on WAITING_FOR_PERMISSION forever, with
      // no event that would ever clear it -- observed live.
      const resolved = base.status === 'WAITING_FOR_PERMISSION'
        ? {
            status: 'WORKING' as const,
            message: 'Claude is working…',
            pendingPermission: undefined,
            blockedMs: settleBlocked(base, now),
          }
        : { pendingPermission: base.pendingPermission, blockedMs: base.blockedMs };

      if (e.is_interrupt) {
        return {
          ...base,
          ...resolved,
          activity: closeActivity(base.activity, e.tool_use_id, e.tool_name, 'done', now),
          details: 'Interrupted',
        };
      }
      // Deliberate: a failed tool call marks the ACTIVITY failed but does not
      // turn the whole overlay red. Claude routinely recovers from a failed
      // grep or a non-zero exit; flipping to ERROR on each one would make red
      // meaningless exactly when it needs to mean something. Only StopFailure
      // -- the turn itself failing -- sets ERROR. See README.
      const detail = truncate(e.error ?? e.tool_name ?? 'tool call failed', MAX_DETAIL);
      return {
        ...base,
        ...resolved,
        activity: closeActivity(base.activity, e.tool_use_id, e.tool_name, 'failed', now, detail),
        details: `${e.tool_name ?? 'A tool'} failed`,
      };
    }

    case 'PermissionRequest':
      // Primary source. Always wins over a Notification backstop already set.
      return {
        ...base,
        status: 'WAITING_FOR_PERMISSION',
        message: 'Claude needs your attention',
        details: undefined,
        // A second prompt replacing a first must bank the first one's wait.
        blockedMs: settleBlocked(base, now),
        pendingPermission: {
          tool: e.tool_name ?? 'unknown',
          detail: describePermission(e.tool_name, e.tool_input, cwd),
          at: now,
          source: 'PermissionRequest',
        },
      };

    case 'PermissionDenied':
      return {
        ...base,
        status: base.status === 'WAITING_FOR_PERMISSION' ? 'WORKING' : base.status,
        message: base.status === 'WAITING_FOR_PERMISSION' ? 'Claude is working…' : base.message,
        details: `Denied: ${e.tool_name ?? 'tool'}`,
        pendingPermission: undefined,
        blockedMs: settleBlocked(base, now),
      };

    case 'Notification':
      switch (m) {
        case 'permission_prompt':
          // Backstop only. If PermissionRequest already told us -- richer, with
          // the real tool input -- do not stack a second alert on top of it.
          if (base.pendingPermission) return base;
          return {
            ...base,
            status: 'WAITING_FOR_PERMISSION',
            message: 'Claude needs your attention',
            pendingPermission: {
              tool: e.tool_name ?? 'unknown',
              detail: truncate(e.message, MAX_DETAIL) || 'Claude needs permission',
              at: now,
              source: 'Notification',
            },
          };
        case 'idle_prompt':
        case 'agent_needs_input':
        case 'elicitation_dialog':
          return {
            ...base,
            status: 'WAITING_FOR_INPUT',
            // Keep what Claude actually SAID, when a completed turn just said it.
            //
            // The notification body is boilerplate -- "Claude is waiting for your
            // input" -- while the last assistant message IS the question being
            // asked. Taking the notification's wording replaced the one useful
            // sentence on the bar with a label for it.
            //
            // Only from COMPLETED: that is the state a `Stop` just set, so the
            // message is this turn's. In any other state it belongs to an older
            // turn and the boilerplate, while dull, is at least current.
            message: (base.status === 'COMPLETED' && base.message)
              || truncate(e.message, MAX_MESSAGE)
              || 'Claude is waiting for you',
          };
        case 'agent_completed':
          // Corroborates Stop. Stop is richer (it carries the summary line), so
          // only act when Stop has not already landed.
          if (base.status === 'COMPLETED') return base;
          return { ...base, status: 'COMPLETED', message: truncate(e.message, MAX_MESSAGE) || 'Done' };
        default:
          return base;
      }

    case 'Stop':
      return {
        ...base,
        status: 'COMPLETED',
        message: truncate(e.last_assistant_message, MAX_MESSAGE) || 'Done',
        details: base.filesChanged.length
          ? `${base.filesChanged.length} file${base.filesChanged.length === 1 ? '' : 's'} changed`
          : undefined,
        pendingPermission: undefined,
        blockedMs: settleBlocked(base, now),
        // Close anything still spinning; the turn is over by definition.
        activity: base.activity.map((a) =>
          a.status === 'running' ? { ...a, status: 'done' as const, endedAt: now } : a),
        compacting: false,
      };

    case 'StopFailure': {
      const kind = m ?? e.reason ?? 'unknown';
      return {
        ...base,
        status: 'ERROR',
        message: ERROR_LABELS[kind] ?? `Failed: ${kind}`,
        details: truncate(e.error ?? e.message, MAX_DETAIL) || undefined,
        error: { kind, detail: truncate(e.error ?? e.message, MAX_DETAIL) },
        pendingPermission: undefined,
        blockedMs: settleBlocked(base, now),
      };
    }

    case 'SessionEnd':
      return {
        ...base,
        status: 'DISCONNECTED',
        message: `Session ended${m && m !== 'other' ? ` (${m})` : ''}`,
        pendingPermission: undefined,
        blockedMs: settleBlocked(base, now),
        turnStartedAt: undefined,
      };

    // A session actually blocked on a permission prompt emits NOTHING while it
    // waits. So any of these arriving proves the prompt is no longer blocking --
    // it was answered, denied, or interrupted -- even when the event that
    // resolved it is one we never see. Deliberately NOT applied to the default
    // branch: falsely clearing a real prompt hides the one state this app
    // exists for, so unknown future events are left alone.
    case 'SubagentStart':
      return { ...base, ...unblocked(base, now), subagents: base.subagents + 1 };

    case 'SubagentStop':
      return { ...base, ...unblocked(base, now), subagents: Math.max(0, base.subagents - 1) };

    case 'PreCompact':
      // Not cosmetic: compaction is the most common cause of a long silence that
      // otherwise looks like a hang.
      return { ...base, ...unblocked(base, now), compacting: true, details: 'Compacting context…' };

    case 'PostCompact':
      return { ...base, ...unblocked(base, now), compacting: false, details: undefined };

    default:
      // An event we do not model still proves the session is alive.
      return base;
  }
}

export function reduce(state: WatcherState, env: IngestEnvelope): WatcherState {
  const id = env.event.session_id;
  if (!id) return state;
  const prev = state.sessions[id] ?? blankSession(id, env.receivedAt);
  const next = reduceSession(prev, env);
  return {
    sessions: { ...state.sessions, [id]: next },
    activeSessionId: id,
  };
}

/** Convenience for tests and the replay harness. */
export const reduceAll = (state: WatcherState, envs: IngestEnvelope[]): WatcherState =>
  envs.reduce(reduce, state);

/**
 * Sessions the app should forget. A session that ended and has been quiet for a
 * while is gone; one that is merely quiet is NOT -- long silences are normal and
 * must never be turned into a state change (spec section 6).
 */
export function prunable(state: WatcherState, now: number, ttlMs: number): string[] {
  return Object.values(state.sessions)
    .filter((s) => s.status === 'DISCONNECTED' && now - s.lastActivityAt > ttlMs)
    .map((s) => s.sessionId);
}

/** Staleness is a display hint, never a status change. */
export const isStale = (s: SessionState, now: number, thresholdMs: number): boolean =>
  s.status === 'WORKING' && now - s.lastActivityAt > thresholdMs;

export type { Status };
