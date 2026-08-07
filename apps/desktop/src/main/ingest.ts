/**
 * The hook receiver. This is the state signal; everything else is enrichment.
 *
 * Three rules this file exists to enforce:
 *
 *  1. RESPOND FIRST. The handler reads the body, sends 204, and only then
 *     reduces. A hung server stalls the coding session -- the Claude Code
 *     default HTTP hook timeout is 600 seconds.
 *  2. EMPTY 204, ALWAYS. A 2xx with a text body is injected into Claude's
 *     context; a 2xx with JSON is parsed as a decision. V1 observes only, so a
 *     stray log line in a response body would silently pollute conversations.
 *  3. 127.0.0.1 ONLY, token on every request.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { HookEvent, IngestEnvelope } from '@agent-watcher/protocol';
import { tokenMatches } from './config.js';

/** Hook payloads are large (a Write carries the whole file). Cap, do not stream. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface IngestOptions {
  port: number;
  token: string;
  onEvent: (envelope: IngestEnvelope) => void;
  onRejected?: (reason: string, remote?: string) => void;
}

export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(`Port ${port} is already in use.`);
  }
}

const HOOK_PREFIX = '/hooks/claude-code/';

export class IngestServer {
  private server?: Server;

  constructor(private readonly opts: IngestOptions) {}

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.on('error', (err: NodeJS.ErrnoException) => {
        // Fail loudly. Rebinding to a free port would orphan every installed
        // hook, and they fail silently -- the worst possible failure mode.
        reject(err.code === 'EADDRINUSE' ? new PortInUseError(this.opts.port) : err);
      });
      server.listen(this.opts.port, '127.0.0.1', () => {
        this.server = server;
        resolve();
      });
    });
  }

  /** The underlying server, so the WebSocket bridge can share this one port. */
  raw(): Server | undefined {
    return this.server;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private reject(res: ServerResponse, code: number, reason: string, req: IncomingMessage): void {
    this.opts.onRejected?.(reason, req.socket.remoteAddress ?? undefined);
    res.writeHead(code).end();
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';
    const token = req.headers['x-agent-watcher-token'];

    if (!tokenMatches(Array.isArray(token) ? token[0] : token, this.opts.token)) {
      return this.reject(res, 401, `unauthenticated ${req.method} ${url}`, req);
    }
    // Liveness probe for the end-to-end verification in the README.
    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ ok: true, protocolVersion: 1 }));
      return;
    }
    if (req.method !== 'POST' || !url.startsWith(HOOK_PREFIX)) {
      return this.reject(res, 404, `unroutable ${req.method} ${url}`, req);
    }

    // Path is /hooks/claude-code/<Event>[/<matcher>]. The matcher is in the URL
    // because for Notification and StopFailure it is the only reliable way to
    // know WHICH matcher fired -- see hooks-config.ts.
    const [eventName, matcher] = url.slice(HOOK_PREFIX.length).split('/');

    let size = 0;
    const chunks: Buffer[] = [];
    let aborted = false;

    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        this.reject(res, 413, `body over ${MAX_BODY_BYTES} bytes on ${eventName}`, req);
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
      if (aborted) return;
      // ---- respond BEFORE any work. Nothing above this line parses JSON. ----
      res.writeHead(204).end();

      const body = Buffer.concat(chunks).toString('utf8');
      setImmediate(() => {
        let event: HookEvent;
        try {
          event = JSON.parse(body) as HookEvent;
        } catch {
          this.opts.onRejected?.(`unparseable body on ${eventName}`);
          return;
        }
        if (typeof event?.session_id !== 'string' || !event.session_id) {
          this.opts.onRejected?.(`no session_id on ${eventName}`);
          return;
        }
        this.opts.onEvent({
          protocolVersion: 1,
          // Trust the URL over the body for the event name: the URL is what we
          // installed, the body is what we were sent.
          event: { ...event, hook_event_name: eventName || event.hook_event_name },
          matcher: matcher || undefined,
          receivedAt: Date.now(),
        });
      });
    });

    req.on('error', () => {
      aborted = true;
    });
  }
}
