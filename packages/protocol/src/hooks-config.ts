/**
 * Building, merging and removing Agent Watcher's hook entries in a Claude Code
 * settings file.
 *
 * Pure functions over the parsed JSON, so the install/uninstall/drift rules are
 * unit-testable and identical wherever they run. The Electron installer does the
 * file I/O; this decides what the file should contain.
 */

import {
  COMPACT_EVENTS, MATCHER_IN_URL, SUBAGENT_EVENTS, TOOL_MATCHED_EVENTS, UNMATCHED_EVENTS,
} from './events.js';

export interface HttpHook {
  type: 'http';
  url: string;
  timeout: number;
  headers?: Record<string, string>;
  [k: string]: unknown;
}
export interface HookGroup {
  matcher?: string;
  hooks: Array<HttpHook | Record<string, unknown>>;
}
export interface SettingsFile {
  hooks?: Record<string, HookGroup[]>;
  allowedHttpHookUrls?: string[];
  [k: string]: unknown;
}

export const TOKEN_HEADER = 'X-Agent-Watcher-Token';

/**
 * Every hook gets an explicit short timeout. The Claude Code default for HTTP
 * hooks is 600 SECONDS -- if this app ever hangs while holding a connection,
 * that default would stall the coding session for ten minutes. Five seconds is
 * far more than a 204-and-forget handler needs.
 */
const DEFAULT_TIMEOUT = 5;
/**
 * SessionEnd hooks share a ~1.5s budget, and Claude Code RAISES that shared
 * budget to match the longest per-hook timeout. Asking for 5 here would delay
 * everyone else's exit hooks too, so this one asks for the minimum.
 */
const SESSION_END_TIMEOUT = 1;

export const hookBaseUrl = (port: number): string =>
  `http://127.0.0.1:${port}/hooks/claude-code`;

const entry = (url: string, token: string, timeout: number): HttpHook => ({
  type: 'http',
  url,
  timeout,
  headers: { [TOKEN_HEADER]: token },
});

/**
 * The complete hook set.
 *
 * Note the URL layout: `/hooks/claude-code/<Event>` for events whose body tells
 * us everything, `/hooks/claude-code/<Event>/<matcher>` for Notification,
 * StopFailure, SessionStart and SessionEnd -- where WHICH matcher fired is the
 * information we need and no payload field is documented to carry it. One entry
 * per matcher, and the ingest handler reads it off the path.
 */
/**
 * The timeout PermissionRequest needs when the app is allowed to answer prompts.
 *
 * While a decision is outstanding the tool call is BLOCKED, so this is the
 * longest the app can ever stall one. A few seconds of headroom over the app's
 * own window means the app always answers first -- an app-sent empty response is
 * tidier than letting Claude Code hit its own timeout, and both land in the same
 * place (the normal permission prompt).
 */
export const decisionTimeoutSeconds = (windowMs: number): number =>
  Math.ceil(windowMs / 1000) + 5;

export function buildHookConfig(
  port: number,
  token: string,
  /** Set only when permission decisions are enabled. Raises ONE hook's timeout. */
  decisionWindowMs?: number,
): Record<string, HookGroup[]> {
  const base = hookBaseUrl(port);
  const out: Record<string, HookGroup[]> = {};

  for (const [event, matchers] of Object.entries(MATCHER_IN_URL)) {
    const timeout = event === 'SessionEnd' ? SESSION_END_TIMEOUT : DEFAULT_TIMEOUT;
    out[event] = matchers.map((matcher) => ({
      matcher,
      hooks: [entry(`${base}/${event}/${matcher}`, token, timeout)],
    }));
  }
  for (const event of [...TOOL_MATCHED_EVENTS, ...SUBAGENT_EVENTS, ...COMPACT_EVENTS]) {
    // PermissionRequest is the ONLY event that may hold its response open, and
    // only when decisions are switched on. Everything else keeps the tight
    // 204-and-forget timeout.
    const timeout = event === 'PermissionRequest' && decisionWindowMs
      ? decisionTimeoutSeconds(decisionWindowMs)
      : DEFAULT_TIMEOUT;
    out[event] = [{ matcher: '*', hooks: [entry(`${base}/${event}`, token, timeout)] }];
  }
  for (const event of UNMATCHED_EVENTS) {
    out[event] = [{ hooks: [entry(`${base}/${event}`, token, DEFAULT_TIMEOUT)] }];
  }
  return out;
}

const isOurs = (h: unknown, base: string): boolean =>
  typeof (h as HttpHook)?.url === 'string' && (h as HttpHook).url.startsWith(base);

/**
 * Remove ONLY our entries, leaving every other hook untouched (spec section 4.9).
 * Identity is the URL prefix, which is exact and needs no extra tagging field.
 */
export function removeHooks(settings: SettingsFile, port: number): SettingsFile {
  const base = hookBaseUrl(port);
  const hooks = settings.hooks;
  if (!hooks) return settings;
  const next: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = (groups ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h, base)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) next[event] = kept;
  }
  return { ...settings, hooks: next };
}

/** Idempotent install: strip ours, then append. Never clobbers foreign hooks. */
export function mergeHooks(
  settings: SettingsFile,
  port: number,
  token: string,
  decisionWindowMs?: number,
): SettingsFile {
  const cleaned = removeHooks(settings, port);
  const ours = buildHookConfig(port, token, decisionWindowMs);
  const hooks: Record<string, HookGroup[]> = { ...(cleaned.hooks ?? {}) };
  for (const [event, groups] of Object.entries(ours)) {
    hooks[event] = [...(hooks[event] ?? []), ...groups];
  }
  return { ...cleaned, hooks };
}

/**
 * Has the installed config drifted from what this app now expects?
 *
 * The hook URL and token live in a settings FILE, so they must be stable across
 * launches. If the port or token changed, every installed hook is pointing at
 * nothing -- and because hook failures are silent by design, the only symptom
 * would be an overlay that never updates. Returns a human-readable reason.
 */
export function findDrift(
  settings: SettingsFile,
  port: number,
  token: string,
  decisionWindowMs?: number,
): string | undefined {
  const want = buildHookConfig(port, token, decisionWindowMs);
  const have = settings.hooks ?? {};
  const base = hookBaseUrl(port);

  const missing: string[] = [];
  for (const [event, groups] of Object.entries(want)) {
    const installed = (have[event] ?? []).flatMap((g) => g.hooks ?? []);
    for (const g of groups) {
      const wanted = g.hooks[0] as HttpHook;
      const match = installed.find((h) => (h as HttpHook).url === wanted.url);
      if (!match) {
        missing.push(`${event}${g.matcher && g.matcher !== '*' ? `:${g.matcher}` : ''}`);
        continue;
      }
      if ((match as HttpHook).headers?.[TOKEN_HEADER] !== token) {
        return 'The installed hooks carry a different token than this app is using.';
      }
      // The timeout matters for exactly one event: an installed PermissionRequest
      // timeout shorter than the decision window would let Claude Code give up
      // mid-decision, so every Allow/Deny click would arrive too late.
      if ((match as HttpHook).timeout !== wanted.timeout) {
        return event === 'PermissionRequest'
          ? 'Permission decisions were switched on or off — reinstall the hooks so the PermissionRequest timeout matches.'
          : `The installed ${event} hook has a different timeout than this app expects.`;
      }
    }
  }
  // Stale entries on the same port from an older version of this app.
  const strays = Object.values(have)
    .flatMap((groups) => groups ?? [])
    .flatMap((g) => g.hooks ?? [])
    .filter((h) => isOurs(h, base))
    .filter((h) => !Object.values(want).some((gs) =>
      gs.some((g) => (g.hooks[0] as HttpHook).url === (h as HttpHook).url)));

  if (missing.length) {
    return `${missing.length} hook${missing.length === 1 ? '' : 's'} not installed (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}).`;
  }
  if (strays.length) return `${strays.length} stale Agent Watcher hook(s) from an older install.`;
  return undefined;
}

/**
 * `allowedHttpHookUrls`, if set at ANY settings level, silently prevents HTTP
 * hooks whose URL is not on it from running. Detect it and say exactly what to
 * add, rather than letting the user debug an overlay that never moves.
 */
export function allowlistProblem(
  settings: SettingsFile,
  port: number,
): { needed: string } | undefined {
  const list = settings.allowedHttpHookUrls;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const base = hookBaseUrl(port);
  const ok = list.some((u) => typeof u === 'string' && (base.startsWith(u) || u.startsWith(base)));
  return ok ? undefined : { needed: base };
}
