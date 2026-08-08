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

/** What the app may send back for a PermissionRequest. `null` = no decision. */
export type Decision = { behavior: 'allow' | 'deny' } | null;

export interface IngestOptions {
  port: number;
  token: string;
  onEvent: (envelope: IngestEnvelope) => void;
  onRejected?: (reason: string, remote?: string) => void;
  /**
   * Enabled ONLY when permission decisions are switched on. Lets the app hold a
   * PermissionRequest open and answer it.
   *
   * `settle` MUST be called exactly once. Calling it with `null` — or never
   * calling it, in which case the deadline does — sends an empty 204, which
   * Claude Code treats as "no decision" and falls back to prompting normally.
   * That is the safe default and every failure path lands there.
   */
  onDecisionRequest?: (
    envelope: IngestEnvelope,
    settle: (decision: Decision) => void,
    deadline: number,
  ) => void;
  /** How long a PermissionRequest may be held. 0 disables holding entirely. */
  decisionWindowMs?: number;
  /**
   * The held request is gone -- Claude Code hung up, or we settled it. The UI
   * must drop its Allow/Deny buttons now rather than counting down against a
   * request nobody is waiting on any more.
   */
  onDecisionClosed?: (sessionId: string) => void;
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

      const body = Buffer.concat(chunks).toString('utf8');
      let event: HookEvent | undefined;
      try {
        event = JSON.parse(body) as HookEvent;
      } catch {
        /* handled below, after we have responded */
      }
      const valid = typeof event?.session_id === 'string' && Boolean(event.session_id);
      const envelope: IngestEnvelope | undefined = valid && event
        ? {
            protocolVersion: 1,
            // Trust the URL over the body for the event name: the URL is what we
            // installed, the body is what we were sent.
            event: { ...event, hook_event_name: eventName || event.hook_event_name },
            matcher: matcher || undefined,
            receivedAt: Date.now(),
          }
        : undefined;

      // The ONE event that may hold its response open, and only when decisions
      // are switched on. Everything else keeps 204-and-forget.
      const holding = envelope
        && eventName === 'PermissionRequest'
        && this.opts.onDecisionRequest
        && (this.opts.decisionWindowMs ?? 0) > 0;

      if (!holding) {
        // ---- respond BEFORE any work. Nothing above this line has side effects. ----
        res.writeHead(204).end();
        setImmediate(() => {
          if (!envelope) {
            this.opts.onRejected?.(event ? `no session_id on ${eventName}` : `unparseable body on ${eventName}`);
            return;
          }
          this.opts.onEvent(envelope);
        });
        return;
      }

      this.hold(res, envelope as IngestEnvelope);
    });

    req.on('error', () => {
      aborted = true;
    });
  }

  /**
   * Hold a PermissionRequest open until the app decides, the window expires, or
   * Claude Code hangs up.
   *
   * Three properties this function exists to guarantee:
   *
   *  1. `settle` runs AT MOST ONCE. A second Allow after a Deny, or a click that
   *     races the deadline, must not write to a finished response.
   *  2. Doing nothing is safe. Every path that is not an explicit allow/deny ends
   *     as an empty 204, which Claude Code reads as "no decision" and falls back
   *     to prompting you normally. Silence never approves anything.
   *  3. The timer is cleared on every exit, including client disconnect, so a
   *     hung request cannot leak a handle or fire after teardown.
   */
  private hold(res: ServerResponse, envelope: IngestEnvelope): void {
    const windowMs = this.opts.decisionWindowMs ?? 0;
    const deadline = Date.now() + windowMs;
    let done = false;
    let timer: NodeJS.Timeout | undefined;

    const closed = (): void => {
      this.opts.onDecisionClosed?.(envelope.event.session_id);
    };

    const settle = (decision: Decision): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      closed();
      if (res.writableEnded || res.destroyed) return;
      if (!decision) {
        // No decision: hand it back to Claude Code's own permission flow.
        res.writeHead(204).end();
        return;
      }
      const payload = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: decision.behavior },
        },
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      }).end(payload);
    };

    // Claude Code gave up or the session died -- stop waiting on a click that can
    // no longer matter.
    // Claude Code gave up, the turn was interrupted, or the session died. Nobody
    // is waiting on this any more, so the buttons must go immediately rather than
    // sitting there counting down.
    res.on('close', () => {
      if (!done) {
        done = true;
        if (timer) clearTimeout(timer);
        closed();
      }
    });

    timer = setTimeout(() => settle(null), windowMs);
    this.opts.onDecisionRequest?.(envelope, settle, deadline);
    // The state machine still sees the event, exactly as it would unheld.
    setImmediate(() => this.opts.onEvent(envelope));
  }
}
