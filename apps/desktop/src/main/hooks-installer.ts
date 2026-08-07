/**
 * Writing Agent Watcher's hooks into a Claude Code settings file.
 *
 * The rules live in @agent-watcher/protocol as pure functions; this file only
 * does the I/O -- read, merge, back up, write -- so the merge/uninstall/drift
 * logic stays unit-tested.
 *
 * NEVER writes managed policy settings. The only two files it will ever touch
 * are the two below.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  allowlistProblem, findDrift, hookBaseUrl, mergeHooks, removeHooks,
  type SettingsFile,
} from '@agent-watcher/protocol';

/**
 * `user` is the default: one install covers every project, and a per-project
 * install silently means no overlay in whichever repo you forgot. The token is
 * machine-local either way, and ~/.claude/settings.json is not a committed file.
 */
export type HookScope = 'user' | 'project';

export interface HookStatus {
  scope: HookScope;
  path: string;
  installed: boolean;
  /** Human-readable reason the installed config no longer matches this app. */
  drift?: string;
  /** Set when allowedHttpHookUrls would block our URL. */
  allowlistNeeded?: string;
}

export function settingsPath(scope: HookScope, projectDir?: string): string {
  return scope === 'user'
    ? join(homedir(), '.claude', 'settings.json')
    : join(projectDir ?? process.cwd(), '.claude', 'settings.local.json');
}

function readSettings(file: string): SettingsFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as SettingsFile) : {};
  } catch {
    return {};
  }
}

function writeSettings(file: string, settings: SettingsFile): void {
  mkdirSync(dirname(file), { recursive: true });
  // One backup, taken before the first modification and never overwritten --
  // so it is always the file as it was before Agent Watcher touched anything.
  const backup = `${file}.agent-watcher-backup`;
  if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

export function install(
  scope: HookScope, port: number, token: string, projectDir?: string,
): HookStatus {
  const file = settingsPath(scope, projectDir);
  const settings = readSettings(file);
  writeSettings(file, mergeHooks(settings, port, token));
  return status(scope, port, token, projectDir);
}

export function uninstall(scope: HookScope, port: number, projectDir?: string): HookStatus {
  const file = settingsPath(scope, projectDir);
  if (existsSync(file)) writeSettings(file, removeHooks(readSettings(file), port));
  return { scope, path: file, installed: false };
}

export function status(
  scope: HookScope, port: number, token: string, projectDir?: string,
): HookStatus {
  const file = settingsPath(scope, projectDir);
  const settings = readSettings(file);
  const drift = findDrift(settings, port, token);
  const allow = allowlistProblem(settings, port);
  return {
    scope,
    path: file,
    installed: !drift,
    drift,
    allowlistNeeded: allow?.needed,
  };
}

/**
 * Drift across BOTH scopes, since `allowedHttpHookUrls` set anywhere blocks us
 * and a stale install in the other scope is still worth reporting.
 */
export function overallStatus(
  port: number, token: string, projectDir?: string,
): { user: HookStatus; project: HookStatus; message?: string } {
  const user = status('user', port, token, projectDir);
  const project = status('project', port, token, projectDir);
  const allowlistNeeded = user.allowlistNeeded ?? project.allowlistNeeded;

  let message: string | undefined;
  if (allowlistNeeded) {
    message = `allowedHttpHookUrls is set and does not include ${allowlistNeeded} — hooks will not run until you add it.`;
  } else if (!user.installed && !project.installed) {
    message = `Hooks are not installed. Expected ${hookBaseUrl(port)}.`;
  } else if (!user.installed && user.drift && !user.drift.includes('not installed')) {
    message = `User-level hooks drifted: ${user.drift}`;
  }
  return { user, project, message };
}
