/**
 * Agent Watcher VS Code bridge.
 *
 * WHAT THIS CANNOT DO, stated plainly: it cannot see inside the Claude Code
 * extension. The VS Code API has no way to read another extension's internal
 * state, and terminal scrollback is not readable through any supported API. All
 * agent state comes from Claude Code's hooks, which reach the desktop app
 * directly. This extension only sends things VS Code genuinely knows.
 *
 * It NEVER modifies project files. It only reads workspace metadata.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import WebSocket from 'ws';

const PROTOCOL_VERSION = 1;
const PING_MS = 10_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
const DEBOUNCE_MS = 250;

let ws: WebSocket | undefined;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: NodeJS.Timeout | undefined;
let pingTimer: NodeJS.Timeout | undefined;
let debounceTimer: NodeJS.Timeout | undefined;
let status: vscode.StatusBarItem;
let branch: string | undefined;
let disposed = false;

/**
 * The token, read from the desktop app's own config file. Keeping one copy
 * avoids asking the user to paste a secret into VS Code settings (where it would
 * end up in settings sync). Overridable for unusual installs.
 */
function readToken(): string | undefined {
  const configured = vscode.workspace.getConfiguration('agentWatcher').get<string>('token');
  if (configured) return configured;
  const candidates = process.platform === 'win32'
    ? [join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'agent-watcher-desktop', 'config.json')]
    : process.platform === 'darwin'
      ? [join(homedir(), 'Library', 'Application Support', 'agent-watcher-desktop', 'config.json')]
      : [join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'agent-watcher-desktop', 'config.json')];
  for (const file of candidates) {
    try {
      const cfg = JSON.parse(readFileSync(file, 'utf8')) as { token?: string };
      if (cfg.token) return cfg.token;
    } catch {
      /* app not installed or not launched yet -- we just keep retrying */
    }
  }
  return undefined;
}

const port = (): number =>
  vscode.workspace.getConfiguration('agentWatcher').get<number>('port') ?? 47821;

function setStatus(text: string, warn = false): void {
  status.text = `$(radio-tower) ${text}`;
  status.backgroundColor = warn
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
}

/** Diagnostics across the whole workspace, counted once per update. */
function diagnostics(): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const [, list] of vscode.languages.getDiagnostics()) {
    for (const d of list) {
      if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
      else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
    }
  }
  return { errors, warnings };
}

/**
 * Git branch, read from .git/HEAD rather than through the git extension API --
 * one file read, no dependency on an extension that may be disabled.
 */
function refreshBranch(): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return void (branch = undefined);
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim();
    branch = head.startsWith('ref: ') ? head.slice(5).split('/').slice(2).join('/') : head.slice(0, 7);
  } catch {
    branch = undefined;
  }
}

function send(): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  const editor = vscode.window.activeTextEditor;
  ws.send(JSON.stringify({
    type: 'update',
    protocolVersion: PROTOCOL_VERSION,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    activeFile: editor?.document.uri.fsPath,
    language: editor?.document.languageId,
    gitBranch: branch,
    // The field that earns this extension its place: notifications stay quiet
    // while you are already looking at VS Code.
    focused: vscode.window.state.focused,
    diagnostics: diagnostics(),
  }));
}

const sendSoon = (): void => {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(send, DEBOUNCE_MS);
};

function connect(): void {
  if (disposed || ws) return;
  const token = readToken();
  if (!token) {
    setStatus('Agent Watcher: app not running', true);
    scheduleReconnect();
    return;
  }

  const socket = new WebSocket(`ws://127.0.0.1:${port()}/bridge`);
  ws = socket;

  socket.on('open', () => {
    reconnectDelay = RECONNECT_MIN_MS;
    socket.send(JSON.stringify({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      token,
      vscodeVersion: vscode.version,
    }));
    refreshBranch();
    send();
    pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
    }, PING_MS);
    setStatus('Agent Watcher');
  });

  socket.on('message', (raw) => {
    let msg: { type?: string };
    try {
      msg = JSON.parse(String(raw)) as { type?: string };
    } catch {
      return;
    }
    // The only command we accept. It carries no path, no URL and no command --
    // there is deliberately nothing here that could open a folder or execute
    // anything. It moves focus WITHIN this window; raising the OS window is done
    // by the desktop app opening an already-open FILE via vscode://file/.
    if (msg.type === 'focus') {
      void vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
  });

  const drop = (): void => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = undefined;
    if (ws === socket) ws = undefined;
    setStatus('Agent Watcher: reconnecting', true);
    scheduleReconnect();
  };
  socket.on('close', drop);
  socket.on('error', () => socket.close());
}

function scheduleReconnect(): void {
  if (disposed || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, reconnectDelay);
  // Backoff, capped -- reconnects forever without requiring an app restart.
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

export function activate(context: vscode.ExtensionContext): void {
  disposed = false;
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.tooltip = 'Agent Watcher bridge — sends workspace, focus and diagnostics to the overlay';
  setStatus('Agent Watcher: connecting', true);
  status.show();

  context.subscriptions.push(
    status,
    vscode.window.onDidChangeWindowState(sendSoon),
    vscode.window.onDidChangeActiveTextEditor(sendSoon),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshBranch();
      sendSoon();
    }),
    vscode.languages.onDidChangeDiagnostics(sendSoon),
    vscode.commands.registerCommand('agentWatcher.reconnect', () => {
      ws?.close();
      reconnectDelay = RECONNECT_MIN_MS;
      connect();
    }),
    { dispose: teardown },
  );

  refreshBranch();
  connect();
}

function teardown(): void {
  disposed = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (pingTimer) clearInterval(pingTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  ws?.close();
  ws = undefined;
}

export function deactivate(): void {
  teardown();
}
