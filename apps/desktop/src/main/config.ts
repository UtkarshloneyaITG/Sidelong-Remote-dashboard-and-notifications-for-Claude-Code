/**
 * Persistent local config: the port and the shared token.
 *
 * Both must be STABLE across launches, because they are written into a Claude
 * Code settings file at install time. A per-launch random port or token would
 * silently orphan every installed hook, and hook failures are non-blocking by
 * design -- so the only symptom would be an overlay that never moves.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';

export interface AppConfig {
  /** Fixed by default. If it is taken we fail loudly rather than rebind. */
  port: number;
  /** Shared secret for hook POSTs and bridge connections. Never leaves this machine. */
  token: string;
  /**
   * Global show/collapse shortcut.
   *
   * NOTE: the default collides with VS Code's "Trigger Parameter Hints"
   * (Ctrl+Shift+Space). A global shortcut wins, so VS Code loses that binding
   * while Sidelong runs. Change this line if you use parameter hints --
   * Ctrl+Alt+Space is unbound on a stock Windows + VS Code setup.
   */
  shortcut: string;
  /** After this much silence a WORKING session is dimmed. Never re-statused. */
  staleMs: number;
  /** COMPLETED collapses back to the pill after this long. 0 disables. */
  completedDismissMs: number;
  /** Opt-in, local-only debug log. Off by default: payloads are sensitive. */
  debugLog: boolean;
  /**
   * Let the overlay ANSWER permission prompts with Allow / Deny.
   *
   * OFF by default, deliberately. It changes what this app is: a watcher becomes
   * something that can approve a command, so the UI gains a path to execution
   * that did not exist before.
   *
   * It also has a cost even when you never click. While a decision is
   * outstanding the tool call is blocked and **VS Code's own prompt does not
   * appear** — so if you ignore the overlay, you have delayed the normal prompt
   * by up to `decisionWindowMs`. Mitigated by answering instantly with "no
   * decision" whenever the bridge says VS Code already has focus.
   *
   * Changing this requires reinstalling the hooks: it alters the installed
   * PermissionRequest timeout, and the app will tell you if they drift.
   */
  permissionDecisions: boolean;
  /**
   * How long a prompt may be held waiting for your click. Keep it short — it is
   * the longest this app can ever stall one tool call.
   */
  decisionWindowMs: number;
  expanded: boolean;
  /**
   * Width of the minimized bar. Height is fixed: the capsule resizes
   * horizontally only, because a taller capsule is just a broken capsule, while
   * a wider one genuinely shows more of the command.
   */
  barWidth: number;
  /** Size of the expanded card, which resizes on both axes. */
  expandedSize: { width: number; height: number };
  bounds?: { x: number; y: number; width: number; height: number };
}

export const DEFAULT_PORT = 47821;

const DEFAULTS: Omit<AppConfig, 'token'> = {
  port: DEFAULT_PORT,
  shortcut: 'Control+Shift+Space',
  staleMs: 90_000,
  completedDismissMs: 20_000,
  debugLog: false,
  permissionDecisions: false,
  decisionWindowMs: 15_000,
  expanded: false,
  barWidth: 560,
  expandedSize: { width: 348, height: 428 },
};

let cached: AppConfig | undefined;

const configPath = (): string => join(app.getPath('userData'), 'config.json');

/**
 * File permissions: chmod 0600 on POSIX. On Windows the ACL on
 * %APPDATA%\<app> already restricts the directory to the current user and
 * Administrators, so no extra work (and no icacls subprocess) is needed.
 */
function harden(file: string): void {
  if (process.platform !== 'win32') {
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort -- a readable config is a local-token leak, not a remote one */
    }
  }
}

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const file = configPath();
  let stored: Partial<AppConfig> = {};
  try {
    stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
  } catch {
    /* first run */
  }
  cached = {
    ...DEFAULTS,
    ...stored,
    token: stored.token && stored.token.length >= 32 ? stored.token : randomBytes(32).toString('hex'),
  };
  if (!stored.token) saveConfig(cached);
  return cached;
}

export function saveConfig(next: AppConfig): void {
  cached = next;
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  harden(file);
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...loadConfig(), ...patch };
  saveConfig(next);
  return next;
}

/** Constant-time token comparison. Length is compared first, unavoidably. */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
