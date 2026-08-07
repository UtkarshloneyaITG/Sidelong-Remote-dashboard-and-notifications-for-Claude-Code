/**
 * Agent adapters.
 *
 * The overlay renders a LIST of agents even though V1 ships one, so adding a
 * Codex or Gemini adapter later is a new file here plus one `register()` call --
 * not a change to the UI or to the state machine.
 *
 * An adapter owns whatever source its agent exposes. Claude Code's source is the
 * HTTP hook receiver, which the Electron main process owns because the port must
 * be fixed and shared; so `ClaudeCodeAdapter.start()/stop()` are just readiness
 * flags and events arrive through `ingest()`. A future adapter that tails a log
 * file or watches a socket would do that work in `start()`.
 */

import {
  initialState, reduce, type IngestEnvelope, type WatcherState,
} from '@agent-watcher/protocol';

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
