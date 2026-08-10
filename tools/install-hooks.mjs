#!/usr/bin/env node
/**
 * Install / remove / inspect Sidelong's Claude Code hooks from the command
 * line. Does exactly what the app's Hooks panel does -- it calls the same pure
 * functions from @sidelong/protocol -- for headless setup and for verifying
 * an install without launching the GUI.
 *
 *   node tools/install-hooks.mjs status
 *   node tools/install-hooks.mjs install [--scope user|project] [--dir <path>]
 *   node tools/install-hooks.mjs uninstall [--scope user|project] [--dir <path>]
 *
 * Default scope is `user` (~/.claude/settings.json): one install covers every
 * project, which is the point of an overlay you glance at from another app.
 * `project` writes .claude/settings.local.json, which is gitignored.
 *
 * NEVER touches managed policy settings.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let protocol;
try {
  protocol = require('../packages/protocol/dist/index.js');
} catch {
  console.error('Build the protocol package first:  npm run build:packages');
  process.exit(1);
}
const { allowlistProblem, findDrift, hookBaseUrl, mergeHooks, removeHooks } = protocol;

const args = process.argv.slice(2);
const cmd = args[0] ?? 'status';
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const scope = flag('scope', 'user') === 'project' ? 'project' : 'user';
const projectDir = resolve(flag('dir', process.cwd()));

const settingsFile = scope === 'user'
  ? join(homedir(), '.claude', 'settings.json')
  : join(projectDir, '.claude', 'settings.local.json');

/** The app's config, so the CLI and the GUI always agree on port and token. */
function appConfig() {
  const dirs = process.platform === 'win32'
    ? [join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Sidelong')]
    : process.platform === 'darwin'
      ? [join(homedir(), 'Library', 'Application Support', 'Sidelong')]
      : [join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Sidelong')];
  for (const d of dirs) {
    try {
      return JSON.parse(readFileSync(join(d, 'config.json'), 'utf8'));
    } catch { /* not launched yet */ }
  }
  return null;
}

const read = (f) => {
  try {
    const v = JSON.parse(readFileSync(f, 'utf8'));
    return typeof v === 'object' && v !== null ? v : {};
  } catch {
    return {};
  }
};

const write = (f, s) => {
  mkdirSync(dirname(f), { recursive: true });
  const backup = `${f}.sidelong-backup`;
  if (existsSync(f) && !existsSync(backup)) copyFileSync(f, backup);
  writeFileSync(f, JSON.stringify(s, null, 2) + '\n', 'utf8');
};

const cfg = appConfig();
if (!cfg && cmd !== 'uninstall') {
  console.error(
    'Could not find the desktop app config. Launch Sidelong once so it can\n'
    + 'generate its port and token, then run this again.',
  );
  process.exit(1);
}
const port = cfg?.port ?? 47821;
const token = cfg?.token ?? '';

switch (cmd) {
  case 'install': {
    write(settingsFile, mergeHooks(read(settingsFile), port, token));
    console.log(`installed -> ${settingsFile}`);
    console.log(`hooks POST to ${hookBaseUrl(port)}`);
    console.log('verify inside Claude Code with:  /hooks');
    break;
  }
  case 'uninstall': {
    if (!existsSync(settingsFile)) {
      console.log(`nothing to do: ${settingsFile} does not exist`);
      break;
    }
    write(settingsFile, removeHooks(read(settingsFile), port));
    console.log(`removed Sidelong hooks from ${settingsFile}`);
    break;
  }
  case 'status': {
    const settings = read(settingsFile);
    const drift = findDrift(settings, port, token);
    const allow = allowlistProblem(settings, port);
    console.log(`file      ${settingsFile}`);
    console.log(`url       ${hookBaseUrl(port)}`);
    console.log(`installed ${drift ? `no — ${drift}` : 'yes'}`);
    if (allow) {
      console.log(`WARNING   allowedHttpHookUrls is set and excludes us. Add: ${allow.needed}`);
    }
    break;
  }
  default:
    console.error('usage: install-hooks.mjs <status|install|uninstall> [--scope user|project] [--dir <path>]');
    process.exit(1);
}
