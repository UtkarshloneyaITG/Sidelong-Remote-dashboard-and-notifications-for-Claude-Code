/**
 * WebSocket server for the VS Code bridge.
 *
 * Secondary and optional. It cannot see inside Claude Code; what it provides is
 * workspace paths (to correlate a hook's cwd to a window), the active file, git
 * branch, diagnostics, and -- the one that earns its keep -- whether VS Code
 * currently has OS focus, so notifications stay quiet when you are already
 * looking at it.
 */

import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, parseBridgeMessage, type BridgeInfo } from '@agent-watcher/protocol';
import { tokenMatches } from './config.js';

const HEARTBEAT_MS = 15_000;
/** No traffic for this long and we assume the window is gone. */
const DEAD_MS = 45_000;

export interface BridgeServerOptions {
  port: number;
  token: string;
  onChange: (info: BridgeInfo) => void;
  onRejected?: (reason: string) => void;
}

export class BridgeServer {
  private wss?: WebSocketServer;
  private client?: WebSocket;
  private timer?: NodeJS.Timeout;
  private info: BridgeInfo = { status: 'disconnected' };

  constructor(private readonly opts: BridgeServerOptions) {}

  getInfo(): BridgeInfo {
    return this.info;
  }

  /** Shares the ingest port via a distinct path, so only one port is configured. */
  attachTo(httpServer: Server): void {
    this.wss = new WebSocketServer({ server: httpServer, path: '/bridge' });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    this.timer = setInterval(() => this.sweep(), HEARTBEAT_MS);
  }

  private setInfo(patch: Partial<BridgeInfo>): void {
    this.info = { ...this.info, ...patch };
    this.opts.onChange(this.info);
  }

  private onConnection(ws: WebSocket): void {
    let authed = false;

    // An unauthenticated socket gets a short grace period to say hello, then dies.
    const authTimer = setTimeout(() => {
      if (!authed) {
        this.opts.onRejected?.('bridge connection never authenticated');
        ws.close(1008, 'unauthenticated');
      }
    }, 5_000);

    ws.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        this.opts.onRejected?.('bridge sent unparseable JSON');
        return;
      }
      const msg = parseBridgeMessage(parsed);
      if ('error' in msg) {
        this.opts.onRejected?.(`bridge message rejected: ${msg.error}`);
        if (msg.error.startsWith('protocol')) ws.close(1008, 'protocol version mismatch');
        return;
      }

      if (msg.type === 'hello') {
        if (!tokenMatches(msg.token, this.opts.token)) {
          this.opts.onRejected?.('bridge presented a bad token');
          ws.close(1008, 'bad token');
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        // Last writer wins: reopening VS Code replaces the old socket rather
        // than leaving a zombie that never reports focus again.
        if (this.client && this.client !== ws) this.client.close(1000, 'replaced');
        this.client = ws;
        this.setInfo({ status: 'connected', lastSeenAt: Date.now() });
        ws.send(JSON.stringify({ type: 'welcome' }));
        return;
      }
      if (!authed) return;

      if (msg.type === 'ping') {
        this.setInfo({ lastSeenAt: Date.now() });
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      this.setInfo({
        status: 'connected',
        workspaceFolders: msg.workspaceFolders,
        activeFile: msg.activeFile,
        language: msg.language,
        gitBranch: msg.gitBranch,
        focused: msg.focused,
        diagnostics: msg.diagnostics,
        lastSeenAt: Date.now(),
      });
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (this.client === ws) {
        this.client = undefined;
        // "Bridge disconnected" is a different problem from "no agent session",
        // so it gets its own status rather than blanking the agent state.
        this.setInfo({ status: 'disconnected', focused: false });
      }
    });
    ws.on('error', () => ws.close());
  }

  private sweep(): void {
    if (!this.client) return;
    const last = this.info.lastSeenAt ?? 0;
    if (Date.now() - last > DEAD_MS) {
      this.setInfo({ status: 'reconnecting' });
      this.client.terminate();
      this.client = undefined;
    }
  }

  /** Ask VS Code to bring itself to the front -- the [Open VS Code] action. */
  focusEditor(): boolean {
    if (!this.client || this.info.status !== 'connected') return false;
    this.client.send(JSON.stringify({ type: 'focus' }));
    return true;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.client?.close();
    this.wss?.close();
    this.info = { status: 'disconnected' };
  }
}

export { PROTOCOL_VERSION };
