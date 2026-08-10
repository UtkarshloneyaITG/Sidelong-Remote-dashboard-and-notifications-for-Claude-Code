/**
 * Agent adapters.
 *
 * SCOPE: Claude Code, and only Claude Code. There is exactly one implementation
 * of this interface and no other agent is supported or has been made to work.
 *
 * This is an internal seam, NOT a capability. Do not read it as "works with any
 * agent".
 *
 * The blocker is TRANSPORT, not events. Codex CLI and Gemini CLI both have hook
 * systems with strikingly similar event names and payload fields -- but both run
 * local commands only, handing the JSON to a script on stdin. Codex's docs are
 * explicit that only `type: "command"` handlers run. Claude Code is currently
 * the only one that can POST a hook event to an HTTP URL, and this app's
 * receiver is HTTP, so nothing from the others ever arrives.
 *
 * Bridging one is feasible -- a relay script reading stdin and POSTing to the
 * receiver, plus a per-agent config installer and payload verification against
 * real captures -- but that is real work, not a new file against this interface.
 * The abstraction exists because the registry and the merged-state handling are
 * genuinely simpler expressed this way, and it keeps the UI from hardcoding a
 * single-session layout.
 *
 * An adapter owns whatever source its agent exposes. Claude Code's source is the
 * HTTP hook receiver, which the Electron main process owns because the port must
 * be fixed and shared; so `ClaudeCodeAdapter.start()/stop()` are just readiness
 * flags and events arrive through `ingest()`.
 */

import {
  initialState, reduce, type IngestEnvelope, type WatcherState,
} from '@sidelong/protocol';

export interface AgentEvent {
  adapterId: string;
  envelope: IngestEnvelope;
  state: WatcherState;
}

export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): WatcherState;
  subscribe(cb: (event: AgentEvent) => void): () => void;
}

/** Shared subscribe/notify plumbing, so an adapter only writes its own logic. */
abstract class BaseAdapter implements AgentAdapter {
  abstract readonly id: string;
  abstract readonly name: string;

  protected state: WatcherState = initialState;
  private subscribers = new Set<(e: AgentEvent) => void>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  getState(): WatcherState {
    return this.state;
  }

  subscribe(cb: (event: AgentEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  protected emit(envelope: IngestEnvelope): void {
    this.state = reduce(this.state, envelope);
    const event: AgentEvent = { adapterId: this.id, envelope, state: this.state };
    for (const cb of this.subscribers) cb(event);
  }
}

export class ClaudeCodeAdapter extends BaseAdapter {
  readonly id = 'claude-code';
  readonly name = 'Claude Code';

  private started = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  /** Called by the HTTP ingest handler, once per received hook event. */
  ingest(envelope: IngestEnvelope): void {
    if (!this.started) return;
    this.emit(envelope);
  }

  /** Drop sessions the reducer says are gone. Never touches live ones. */
  prune(ids: string[]): void {
    if (!ids.length) return;
    const sessions = { ...this.state.sessions };
    for (const id of ids) delete sessions[id];
    const activeSessionId = this.state.activeSessionId && sessions[this.state.activeSessionId]
      ? this.state.activeSessionId
      : undefined;
    this.state = { sessions, activeSessionId };
  }
}

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>();
  private unsubscribes: Array<() => void> = [];
  private subscribers = new Set<(e: AgentEvent) => void>();

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
    this.unsubscribes.push(adapter.subscribe((e) => {
      for (const cb of this.subscribers) cb(e);
    }));
  }

  get<T extends AgentAdapter = AgentAdapter>(id: string): T | undefined {
    return this.adapters.get(id) as T | undefined;
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  subscribe(cb: (e: AgentEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /**
   * Every adapter's sessions in one map. Session ids are UUIDs from the agent,
   * so collisions across adapters are not a practical concern; the adapter id is
   * still carried on each event for attribution.
   */
  mergedState(): WatcherState {
    let merged: WatcherState = initialState;
    for (const a of this.adapters.values()) {
      const s = a.getState();
      merged = {
        sessions: { ...merged.sessions, ...s.sessions },
        activeSessionId: s.activeSessionId ?? merged.activeSessionId,
      };
    }
    return merged;
  }

  async startAll(): Promise<void> {
    await Promise.all(this.list().map((a) => a.start()));
  }

  async stopAll(): Promise<void> {
    for (const u of this.unsubscribes) u();
    this.unsubscribes = [];
    await Promise.all(this.list().map((a) => a.stop()));
  }
}
