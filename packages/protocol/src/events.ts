/**
 * Claude Code hook event shapes.
 *
 * Verified against `claude --version` 2.1.119 and against REAL payloads captured
 * from live sessions (see tools/capture, fixtures/). Per the build spec every
 * event-specific field is optional: the hooks reference documents the events but
 * not an exhaustive per-event schema, so the reducer must degrade rather than
 * throw when a field is missing.
 *
 * Zero dependencies, on purpose -- this package is imported by the Electron main
 * process, the renderer, and the VS Code extension.
 */

export const PROTOCOL_VERSION = 1;

/** Present on every payload. Confirmed empirically on all captured events. */
export interface HookCommon {
  session_id: string;
  hook_event_name: string;
  transcript_path?: string;
  cwd?: string;
  prompt_id?: string;
  permission_mode?: string;
  effort?: { level?: string };
  /** Set only when the event came from a subagent, not the top-level session. */
  agent_id?: string;
  agent_type?: string;
}

/**
 * The union of every event-specific field we read, all optional.
 *
 * A flat optional bag rather than a discriminated union: the reducer switches on
 * `hook_event_name` anyway, and a union would force a cast at every ingest point
 * for zero added safety against a server we do not control.
 */
export interface HookEvent extends HookCommon {
  /** SessionStart: startup | resume | clear | compact | fork */
  source?: string;
  model?: string;
  /** UserPromptSubmit. Sensitive -- truncated before it ever leaves the reducer. */
  prompt?: string;
  /** Pre/PostToolUse, PostToolUseFailure, PermissionRequest, PermissionDenied */
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Present on Pre/PostToolUse. NOT present on PermissionRequest (verified). */
  tool_use_id?: string;
  tool_response?: unknown;
  duration_ms?: number;
  error?: string;
  /**
   * PostToolUseFailure. TRUE when the user interrupted (Esc), not when the tool
   * failed. Verified on a real payload -- treating an interrupt as a failure
   * would paint a red activity item for something the user did on purpose.
   */
  is_interrupt?: boolean;
  /** Stop. True when the Stop hook is re-entering; we do not need it, but it exists. */
  stop_hook_active?: boolean;
  /** Notification */
  message?: string;
  title?: string;
  /** Stop */
  last_assistant_message?: string;
  /** SessionEnd, StopFailure */
  reason?: string;
  /** PermissionRequest -- rule suggestions Claude Code would offer in its own UI. */
  permission_suggestions?: unknown[];
}

/**
 * The matcher that fired, recovered from the hook URL path rather than the body.
 *
 * `Notification` and `StopFailure` are only useful if we know WHICH matcher fired
 * (permission_prompt vs idle_prompt; rate_limit vs server_error), and no payload
 * field is documented to carry it. The installer therefore writes one hook entry
 * per matcher with the matcher in the URL -- `/hooks/claude-code/Notification/
 * permission_prompt` -- so the ingest handler reads it off the path. Costs a few
 * extra entries in settings.json and removes all guessing.
 */
export interface IngestEnvelope {
  protocolVersion: number;
  event: HookEvent;
  /** From the URL path. Absent for events whose matcher carries no information. */
  matcher?: string;
  receivedAt: number;
}

/** Events whose matcher we encode in the hook URL because the body may not carry it. */
export const MATCHER_IN_URL: Record<string, readonly string[]> = {
  SessionStart: ['startup', 'resume', 'clear', 'compact', 'fork'],
  SessionEnd: ['clear', 'resume', 'logout', 'prompt_input_exit', 'bypass_permissions_disabled', 'other'],
  Notification: [
    'permission_prompt', 'idle_prompt', 'agent_needs_input', 'agent_completed',
    'auth_success', 'elicitation_dialog', 'elicitation_complete', 'elicitation_response',
  ],
  StopFailure: [
    'rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed',
    'billing_error', 'invalid_request', 'model_not_found', 'server_error',
    'max_output_tokens', 'unknown',
  ],
};

/** Events we subscribe to with a `*` tool matcher (tool_name arrives in the body). */
export const TOOL_MATCHED_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied',
] as const;

/** Events with no matcher support at all. */
export const UNMATCHED_EVENTS = ['UserPromptSubmit', 'Stop'] as const;

/** Subagent lifecycle. Matcher is the agent type; we take them all with `*`. */
export const SUBAGENT_EVENTS = ['SubagentStart', 'SubagentStop'] as const;

/** Compaction. Explains an otherwise inexplicable multi-minute silence. */
export const COMPACT_EVENTS = ['PreCompact', 'PostCompact'] as const;
