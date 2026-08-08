/**
 * The overlay.
 *
 * This component holds NO agent state. It renders the view model pushed from the
 * main process and nothing else. The only local state here is presentational:
 * which panel is open, and a 1Hz clock used to tick the elapsed counter between
 * pushes. Neither can change a status.
 */

import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { OverlayView, SessionView, Severity } from '@agent-watcher/protocol';

type RendererView = OverlayView & { expanded: boolean };

declare global {
  interface Window {
    watcher: {
      onView(cb: (v: RendererView) => void): () => void;
      getView(): Promise<RendererView>;
      setExpanded(expanded: boolean): Promise<void>;
      openEditor(sessionId?: string): Promise<{ via: string }>;
      acknowledge(sessionId: string, key: string): Promise<void>;
      decide(sessionId: string, behavior: 'allow' | 'deny' | 'defer'): Promise<{ ok: boolean }>;
      quit(): Promise<void>;
      hooks: {
        status(): Promise<HookStatusPayload>;
        install(scope: 'user' | 'project'): Promise<unknown>;
        uninstall(scope: 'user' | 'project'): Promise<unknown>;
      };
    };
  }
}

interface HookStatusPayload {
  user: { installed: boolean; path: string; drift?: string; allowlistNeeded?: string };
  project: { installed: boolean; path: string };
  message?: string;
  port: number;
  url: string;
}

const DOT: Record<Severity, string> = {
  active: 'bg-emerald-400',
  attention: 'bg-amber-400',
  success: 'bg-sky-400',
  error: 'bg-rose-500',
  neutral: 'bg-zinc-500',
  offline: 'bg-zinc-600',
};

const RING: Record<Severity, string> = {
  active: 'shadow-[0_0_0_3px_rgba(52,211,153,0.15)]',
  attention: 'shadow-[0_0_0_3px_rgba(251,191,36,0.20)]',
  success: 'shadow-[0_0_0_3px_rgba(56,189,248,0.15)]',
  error: 'shadow-[0_0_0_3px_rgba(244,63,94,0.20)]',
  neutral: '',
  offline: '',
};

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Elapsed, ticked locally between pushes. Derived from a real turnStartedAt. */
function useElapsed(session: SessionView | undefined): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!session?.turnStartedAt) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [session?.turnStartedAt]);
  if (!session) return 0;
  return session.turnStartedAt ? Date.now() - session.turnStartedAt : session.elapsedMs;
}

function Dot({ severity, pulse }: { severity: Severity; pulse?: boolean }): JSX.Element {
  return (
    <span className={`relative inline-flex h-2 w-2 shrink-0 rounded-full ${DOT[severity]} ${RING[severity]}`}>
      {pulse && (
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${DOT[severity]}`} />
      )}
    </span>
  );
}

// -------------------------------------------------------------------- panels

/**
 * Focus VS Code, and say something when we cannot.
 *
 * Returns a hint to show for a few seconds when nothing happened, because a
 * button that silently does nothing is worse than one that explains itself.
 */
function useOpenEditor(): [string | null, (sessionId?: string) => void] {
  const [hint, setHint] = useState<string | null>(null);
  const open = useCallback((sessionId?: string) => {
    void window.watcher.openEditor(sessionId).then(({ via }) => {
      if (via !== 'none') return;
      setHint('Install the VS Code bridge to focus the window');
      setTimeout(() => setHint(null), 4000);
    });
  }, []);
  return [hint, open];
}

function PermissionCard({ session }: { session: SessionView }): JSX.Element | null {
  const [hint, open] = useOpenEditor();
  const p = session.permissionActionable ? session.pendingPermission : undefined;
  if (!p) return null;
  return (
    <div className="mx-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-300">
        <span aria-hidden>⚠</span> Claude needs your attention
      </div>
      <div className="mt-1.5 break-words font-mono text-[11px] leading-relaxed text-zinc-100">
        {p.detail}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className="no-drag rounded-md bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-900 transition hover:bg-white"
          onClick={() => open(session.sessionId)}
        >
          Open VS Code
        </button>
        {/* V1 observes only. There is deliberately no Allow/Deny here -- see
            README section on Phase 6. */}
        <span className="text-[10px] text-zinc-500">
          {hint ?? (p.source === 'Notification' ? 'via notification' : p.tool)}
        </span>
      </div>
    </div>
  );
}

function ActivityList({ session }: { session: SessionView }): JSX.Element | null {
  const items = [...session.activity].reverse().slice(0, 8);
  if (!items.length) return null;
  return (
    <div className="mt-1 px-2">
      <div className="px-0.5 pb-1 text-[10px] uppercase tracking-wider text-zinc-600">Activity</div>
      <ul className="space-y-0.5">
        {items.map((a) => (
          <li key={a.id} className="flex items-start gap-2 rounded px-0.5 py-0.5 text-[11px]">
            <span
              className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${
                a.status === 'failed' ? 'bg-rose-500'
                  : a.status === 'running' ? 'bg-emerald-400' : 'bg-zinc-600'
              }`}
            />
            <span className={`min-w-0 flex-1 truncate ${a.status === 'failed' ? 'text-rose-300' : 'text-zinc-300'}`}>
              {a.label}
            </span>
            {a.agentType && (
              <span className="shrink-0 rounded bg-zinc-800 px-1 text-[9px] text-zinc-500">{a.agentType}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilesChanged({ session }: { session: SessionView }): JSX.Element | null {
  if (!session.filesChanged.length) return null;
  return (
    <div className="mt-2 px-2">
      <div className="px-0.5 pb-1 text-[10px] uppercase tracking-wider text-zinc-600">
        {session.filesChanged.length} file{session.filesChanged.length === 1 ? '' : 's'} changed
      </div>
      <ul className="space-y-0.5">
        {session.filesChanged.slice(-6).map((f) => (
          <li key={f} className="truncate px-0.5 font-mono text-[10.5px] text-zinc-400">{f}</li>
        ))}
      </ul>
    </div>
  );
}

function Setup({ onClose }: { onClose: () => void }): JSX.Element {
  const [status, setStatus] = useState<HookStatusPayload | null>(null);
  const refresh = useCallback(() => {
    void window.watcher.hooks.status().then(setStatus);
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-zinc-950 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-zinc-200">Hook setup</span>
        <button type="button" className="no-drag text-[11px] text-zinc-500 hover:text-zinc-200" onClick={onClose}>
          close
        </button>
      </div>
      {status && (
        <>
          <p className="mt-2 text-[10.5px] leading-relaxed text-zinc-400">
            Agent Watcher listens on <span className="font-mono text-zinc-300">127.0.0.1:{status.port}</span> and
            installs Claude Code hooks that POST there. Nothing leaves this machine.
          </p>
          {status.message && (
            <p className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[10.5px] text-amber-200">
              {status.message}
            </p>
          )}
          <div className="mt-3 space-y-2">
            {(['user', 'project'] as const).map((scope) => (
              <div key={scope} className="rounded border border-zinc-800 p-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-zinc-300">
                    {scope === 'user' ? 'All projects' : 'This project only'}
                  </span>
                  <span className={`text-[10px] ${status[scope].installed ? 'text-emerald-400' : 'text-zinc-600'}`}>
                    {status[scope].installed ? 'installed' : 'not installed'}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[9.5px] text-zinc-600">{status[scope].path}</div>
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    type="button"
                    className="no-drag rounded bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-900 hover:bg-white"
                    onClick={() => void window.watcher.hooks.install(scope).then(refresh)}
                  >
                    Install
                  </button>
                  <button
                    type="button"
                    className="no-drag rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-100"
                    onClick={() => void window.watcher.hooks.uninstall(scope).then(refresh)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-auto pt-2 text-[10px] text-zinc-600">
            Verify inside Claude Code with <span className="font-mono text-zinc-500">/hooks</span>. Closing
            Agent Watcher never affects a running session.
          </p>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------- minimized bar

/**
 * The minimized bar. One shape, three densities:
 *
 *   idle        ● Claude · project ──────────────── 04:32  ▸
 *   auto-run    ● project │ npm run build ───────── 00:12  ▸
 *   permission  ● project │ npm install │ [Open VS Code] [ok]
 *
 * Buttons appear ONLY when there is a pending permission. When Claude is
 * auto-running commands there is nothing for you to act on, so the bar just
 * tracks what is running.
 *
 * [ok] acknowledges — it shrinks the bar and stops the pulse. It sends nothing
 * to Claude Code. The status stays WAITING_FOR_PERMISSION and the expanded view
 * still shows the prompt. Acknowledging is not approving.
 */
function MinimizedBar({ view, elapsed }: { view: RendererView; elapsed: number }): JSX.Element {
  const [hint, open] = useOpenEditor();
  const a = view.active;
  const severity: Severity = a?.severity ?? 'offline';
  // permissionActionable, NOT pendingPermission: a prompt about to be
  // auto-approved must not put buttons in front of you for a command that is
  // already running.
  const pending = a?.permissionActionable ? a.pendingPermission : undefined;
  // Always say what Claude is DOING -- reading, writing, running, thinking --
  // rather than a status label. Computed once in the protocol so the bar and the
  // expanded card can never disagree.
  const headline = a?.headline;
  const asCommand = a?.headlineIsCommand ?? false;

  return (
    <div
      className={`drag relative flex h-screen w-screen items-center gap-2.5 overflow-hidden rounded-full border-2 bg-zinc-950 px-2.5 transition-colors duration-300 ${
        pending ? 'border-amber-500/60' : 'border-zinc-700/80'
      }`}
    >
      <span className="flex shrink-0 items-center gap-2 pl-0.5">
        <Dot severity={severity} pulse={Boolean(pending) || (a?.status === 'WORKING' && !a.stale)} />
        <span className="max-w-[110px] truncate text-[11.5px] font-medium text-zinc-200">
          {a?.project ?? (a ? 'Claude' : 'No session')}
        </span>
        {view.otherSessions > 0 && (
          <span className="shrink-0 rounded bg-zinc-800 px-1 text-[9.5px] text-zinc-400">
            +{view.otherSessions}
          </span>
        )}
      </span>

      {/* The one flexible cell. It always occupies the same space, so nothing
          below re-flows when a command starts, ends, or a prompt arrives. */}
      {hint ? (
        <span className="min-w-0 flex-1 truncate text-[11px] text-amber-300">{hint}</span>
      ) : asCommand ? (
        <span
          className={`min-w-0 flex-1 truncate rounded-md px-2.5 py-1.5 font-mono text-[11.5px] transition-colors duration-300 ${
            pending ? 'bg-amber-500/12 text-amber-100' : 'bg-zinc-800/80 text-zinc-300'
          }`}
          title={headline}
        >
          {headline}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-zinc-400">
          {headline ?? 'Waiting for a Claude Code session.'}
        </span>
      )}

      <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-400">
        {a && (a.turnStartedAt ?? a.elapsedMs) ? clock(elapsed) : ''}
      </span>

      {/* Hooks not installed / drifted means the overlay will simply never
          update. Surfaced here too, or the bar would look merely idle. */}
      {view.hookConfigDrift && (
        <span className="shrink-0 text-[11px] text-amber-400" title={view.hookConfigDrift}>
          ⚠
        </span>
      )}
      <button
        type="button"
        aria-label="Expand"
        className="no-drag shrink-0 pr-0.5 text-[11px] text-zinc-600 transition hover:text-zinc-300"
        onClick={() => void window.watcher.setExpanded(true)}
      >
        ▸
      </button>

      {/*
        Allow / Deny. Present ONLY while the app is actually holding this
        session's PermissionRequest open -- `a.decision` is absent unless the
        feature is switched on AND the hold has not lapsed, so by default this
        never renders and the app stays a watcher.

        The countdown is not decoration: it says how long until the hold lapses
        and Claude Code prompts you normally instead. Nothing is lost when it
        runs out.
      */}
      {a?.decision && (
        <span className="absolute inset-y-0 right-7 z-10 flex items-center gap-1.5 bg-zinc-950 pl-8">
          <span className="font-mono text-[10px] tabular-nums text-zinc-500">
            {Math.max(0, Math.ceil((a.decision.expiresAt - Date.now()) / 1000))}s
          </span>
          <button
            type="button"
            title="Run it. This actually approves the tool call."
            className="no-drag rounded-md bg-emerald-400 px-2.5 py-1 text-[11px] font-semibold text-emerald-950 transition hover:bg-emerald-300"
            onClick={() => void window.watcher.decide(a.sessionId, 'allow')}
          >
            Allow
          </button>
          <button
            type="button"
            title="Refuse it. Claude is told the call was denied."
            className="no-drag rounded-md border border-rose-500/50 px-2.5 py-1 text-[11px] font-semibold text-rose-300 transition hover:bg-rose-500/10"
            onClick={() => void window.watcher.decide(a.sessionId, 'deny')}
          >
            Deny
          </button>
        </span>
      )}

      {/*
        Actions FLOAT over the right end of the bar rather than sitting in the
        layout. Always mounted, only faded, so:
          - the window never resizes and nothing re-flows (the whole complaint),
          - the fade is a real CSS transition rather than a mount pop,
          - pointer-events are off while hidden, so an invisible button is not
            clickable.
        The gradient lets the command text slide under them instead of being
        abruptly cut.
      */}
      <span
        aria-hidden={!pending}
        className={`pointer-events-none absolute inset-y-0 right-7 flex items-center gap-1.5 pl-10 transition-all duration-200 ease-out ${
          pending ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-1 opacity-0'
        }`}
        style={{
          background:
            'linear-gradient(to right, rgba(9,9,11,0) 0%, rgba(9,9,11,0.97) 38%, rgba(9,9,11,0.97) 100%)',
        }}
      >
        <button
          type="button"
          tabIndex={pending ? 0 : -1}
          className={`no-drag rounded-md bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-900 transition hover:bg-white ${
            pending ? 'pointer-events-auto' : ''
          }`}
          onClick={() => a && open(a.sessionId)}
        >
          Open VS Code
        </button>
        <button
          type="button"
          tabIndex={pending ? 0 : -1}
          title="Seen it — stops the bar drawing attention. Does not approve anything."
          className={`no-drag rounded-md bg-zinc-100 px-3 py-1 text-[11px] font-semibold text-zinc-900 transition hover:bg-white ${
            pending ? 'pointer-events-auto' : ''
          }`}
          onClick={() => a && void window.watcher.acknowledge(a.sessionId, a.permissionKey ?? '')}
        >
          ok
        </button>
      </span>
    </div>
  );
}

// ------------------------------------------------------------------- shell

function ConnectionRow({ view }: { view: RendererView }): JSX.Element {
  const bridge = view.bridge.status;
  const bridgeDot = bridge === 'connected' ? 'bg-emerald-400'
    : bridge === 'reconnecting' ? 'bg-amber-400' : 'bg-zinc-600';
  return (
    <div className="mt-auto flex items-center gap-2 border-t border-zinc-800/80 px-2.5 py-1.5 text-[10px] text-zinc-500">
      <span className={`h-1.5 w-1.5 rounded-full ${view.ingestReady ? 'bg-emerald-400' : 'bg-rose-500'}`} />
      <span>{view.ingestReady ? 'Hooks listening' : 'Receiver down'}</span>
      <span className="text-zinc-700">·</span>
      <span className={`h-1.5 w-1.5 rounded-full ${bridgeDot}`} />
      <span className="truncate">
        {bridge === 'connected' ? 'VS Code bridge' : 'VS Code bridge not connected'}
      </span>
      {!view.sessions.length && view.ingestReady && (
        <span className="ml-auto shrink-0 text-zinc-600">no session</span>
      )}
    </div>
  );
}

export default function App(): JSX.Element {
  const [view, setView] = useState<RendererView | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [openHint, openEditor] = useOpenEditor();

  useEffect(() => {
    void window.watcher.getView().then(setView);
    return window.watcher.onView(setView);
  }, []);

  const active = view?.active;
  const elapsed = useElapsed(active);

  if (!view) return <div className="h-screen w-screen" />;

  // Minimized is now the default resting shape: it already shows the command and
  // the actions, so a permission prompt no longer needs to force the big card
  // open. The bar widens itself instead (see barSize in the main process).
  if (!view.expanded) return <MinimizedBar view={view} elapsed={elapsed} />;

  const severity: Severity = active?.severity ?? 'offline';
  const working = active?.status === 'WORKING';

  const header = (
    <div className="drag flex items-center gap-2 px-3 py-2.5">
      <Dot severity={severity} pulse={working && !active?.stale} />
      <span className={`truncate text-[12px] font-medium ${active?.stale ? 'text-zinc-500' : 'text-zinc-100'}`}>
        {active ? 'Claude' : 'No session'}
      </span>
      {active?.project && (
        <span className="truncate text-[11px] text-zinc-500">{active.project}</span>
      )}
      {view.otherSessions > 0 && (
        <span className="shrink-0 rounded bg-zinc-800 px-1 text-[9.5px] text-zinc-400">
          +{view.otherSessions}
        </span>
      )}
      <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-zinc-400">
        {active && (active.turnStartedAt ?? active.elapsedMs) ? clock(elapsed) : ''}
      </span>
      <button
        type="button"
        aria-label="Minimize"
        title="Minimize to the bar"
        className="no-drag shrink-0 px-1 text-[13px] leading-none text-zinc-600 transition hover:text-zinc-200"
        onClick={() => void window.watcher.setExpanded(false)}
      >
        &#8211;
      </button>
    </div>
  );

  return (
    // Opaque, not translucent. `backdrop-blur` cannot sample the desktop behind a
    // transparent Electron window -- it only blurs what is behind it inside the
    // page -- so a see-through card just leaks whatever you happen to be sitting
    // on top of. A status readout has to be legible over a busy editor at a
    // glance, which beats the aesthetic of transparency that never blurred.
    <div className="relative flex h-screen w-screen flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 text-zinc-200 shadow-2xl">
      {header}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-1">
        <div className="px-3 pb-2">
            <div className={`text-[11.5px] leading-snug ${active?.stale ? 'text-zinc-500' : 'text-zinc-300'}`}>
              {active?.headline ?? 'Waiting for a Claude Code session.'}
            </div>
            {active?.details && (
              <div className="mt-0.5 text-[10.5px] text-zinc-500">{active.details}</div>
            )}
            {active?.autoRunning && (
              <div className="mt-1 inline-block rounded bg-zinc-800 px-1.5 py-0.5 text-[9.5px] text-zinc-400">
                auto-run · {active.permissionMode}
              </div>
            )}
            {active?.stale && (
              <div className="mt-0.5 text-[10px] text-zinc-600">No events for a while — still working.</div>
            )}
            {active?.compacting && (
              <div className="mt-0.5 text-[10px] text-zinc-600">Compacting context…</div>
            )}
          </div>

          <PermissionCard session={active ?? ({} as SessionView)} />
          {active && <ActivityList session={active} />}
          {active && <FilesChanged session={active} />}

          {view.sessions.length > 1 && (
            <div className="mt-2 px-2">
              <div className="px-0.5 pb-1 text-[10px] uppercase tracking-wider text-zinc-600">
                Other sessions
              </div>
              {view.sessions.filter((s) => s.sessionId !== active?.sessionId).map((s) => (
                <div key={s.sessionId} className="flex items-center gap-2 px-0.5 py-0.5 text-[11px]">
                  <Dot severity={s.severity} />
                  <span className="truncate text-zinc-400">{s.project ?? s.sessionId.slice(0, 8)}</span>
                  <span className="ml-auto truncate text-[10px] text-zinc-600">{s.status.toLowerCase()}</span>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 flex items-center gap-2 px-2.5">
            <button
              type="button"
              className="no-drag rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-100"
              onClick={() => openEditor(active?.sessionId)}
            >
              Open VS Code
            </button>
            <button
              type="button"
              className="no-drag rounded border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-200"
              onClick={() => setSetupOpen(true)}
            >
              Hooks
            </button>
            {openHint && (
              <span className="truncate text-[9.5px] text-amber-300">{openHint}</span>
            )}
            <button
              type="button"
              className="no-drag ml-auto text-[10px] text-zinc-700 hover:text-zinc-400"
              onClick={() => void window.watcher.quit()}
            >
              Quit
            </button>
          </div>

        {/* The one number nothing else can compute: how long Claude actually
            waited on you today. Only shown once there is something to report. */}
        {(view.blockedTodayMs ?? 0) >= 1000 && (
          <div className="mt-3 flex items-baseline gap-2 px-2.5">
            <span className="text-[10px] uppercase tracking-wider text-zinc-600">
              Waiting on you today
            </span>
            <span className="font-mono text-[11px] tabular-nums text-amber-400/90">
              {clock(view.blockedTodayMs ?? 0)}
            </span>
          </div>
        )}

        <ConnectionRow view={view} />
        {setupOpen && <Setup onClose={() => setSetupOpen(false)} />}
      </div>
    </div>
  );
}
