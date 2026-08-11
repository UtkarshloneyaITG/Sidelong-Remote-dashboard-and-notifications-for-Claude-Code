/**
 * The overlay.
 *
 * This component holds NO agent state. It renders the view model pushed from the
 * main process and nothing else. The only local state here is presentational:
 * which panel is open, and a 1Hz clock used to tick the elapsed counter between
 * pushes. Neither can change a status.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  MIN_SAMPLES, savings, trend,
  type DayCounts, type OverlayView, type SessionView, type Severity,
} from '@sidelong/protocol';

type RendererView = OverlayView & { expanded: boolean; sound: boolean };

declare global {
  interface Window {
    watcher: {
      onView(cb: (v: RendererView) => void): () => void;
      getView(): Promise<RendererView>;
      setExpanded(expanded: boolean): Promise<void>;
      openEditor(sessionId?: string): Promise<{ via: string }>;
      acknowledge(sessionId: string, key: string): Promise<void>;
      decide(sessionId: string, behavior: 'allow' | 'deny' | 'defer'): Promise<{ ok: boolean }>;
      resize(
        width: number,
        height: number,
        anchor?: { side: 'left' | 'right'; x: number },
      ): Promise<void>;
      quit(): Promise<void>;
      stats(): Promise<StatsPayload>;
      settings: {
        get(): Promise<SettingsPayload>;
        set(patch: Partial<SettingsPayload>): Promise<SettingsResult>;
        clearStats(): Promise<{ ok: boolean }>;
        openDataDir(): Promise<{ ok: boolean; dir: string; error?: string }>;
      };
      hooks: {
        status(): Promise<HookStatusPayload>;
        install(scope: 'user' | 'project'): Promise<unknown>;
        uninstall(scope: 'user' | 'project'): Promise<unknown>;
      };
    };
  }
}


interface StatsPayload {
  /** Oldest first, one row per local day, gaps filled with real zeroes. */
  days: {
    date: string;
    blockedMs: number;
    counts: DayCounts;
    /** `commandKey` → prompts about it. Program name and one subcommand only. */
    commands: Record<string, number>;
  }[];
}

interface SettingsPayload {
  port: number;
  shortcut: string;
  staleMs: number;
  completedDismissMs: number;
  debugLog: boolean;
  notifications: boolean;
  sound: boolean;
  permissionDecisions: boolean;
  decisionWindowMs: number;
  openAtLogin: boolean;
  version: string;
  dataDir: string;
  restartRequired: boolean;
}

interface SettingsResult {
  ok: boolean;
  /** Scopes whose hooks were rewritten because the decision timeout moved. */
  reinstalled: string[];
  restartRequired: boolean;
}

interface HookStatusPayload {
  user: { installed: boolean; path: string; drift?: string; allowlistNeeded?: string };
  project: { installed: boolean; path: string };
  message?: string;
  port: number;
  url: string;
}

/**
 * White is reserved for COMPLETED, and nothing else reaches it.
 *
 * A finished turn used to be sky blue next to a working emerald — two bright
 * cool dots 8px across, which is a distinction you have to look for. The end of
 * a turn is the moment you most want to catch from the corner of your eye, so it
 * gets the one colour no other state uses.
 */
const DOT: Record<Severity, string> = {
  active: 'bg-emerald-400',
  attention: 'bg-amber-400',
  success: 'bg-white',
  error: 'bg-rose-500',
  neutral: 'bg-zinc-500',
  offline: 'bg-zinc-600',
};

/**
 * The same states as `DOT`, as literal colour. The bar's light is drawn as an
 * arc and lit by a gradient, and neither a border colour nor a CSS custom
 * property can be a Tailwind class, so these are the values themselves.
 */
const EDGE_HEX: Record<Severity, string> = {
  active: '#34d399', // emerald-400
  attention: '#fbbf24', // amber-400
  success: '#ffffff',
  error: '#f43f5e', // rose-500
  neutral: '#71717a', // zinc-500
  offline: '#52525b', // zinc-600
};

const RING: Record<Severity, string> = {
  active: 'shadow-[0_0_0_3px_rgba(52,211,153,0.15)]',
  attention: 'shadow-[0_0_0_3px_rgba(251,191,36,0.20)]',
  success: 'shadow-[0_0_0_3px_rgba(255,255,255,0.14)]',
  error: 'shadow-[0_0_0_3px_rgba(244,63,94,0.20)]',
  neutral: '',
  offline: '',
};

/**
 * The blocked chime: two notes, synthesised, ~350ms.
 *
 * Synthesised rather than shipped as an audio file. Nothing to package, license
 * or fail to load, and the envelope can be shaped deliberately: a soft attack and
 * a long tail is what separates a chime from a beep, and a square edge at either
 * end is what makes people hate notification sounds.
 *
 * A rising perfect fourth (A5 to D6). It reads as a question rather than an
 * alarm, which is exactly the message -- something is waiting on you, nothing is
 * wrong.
 *
 * One AudioContext, made on first use and kept: browsers cap how many you may
 * open, and a status bar could plausibly chime hundreds of times in a day.
 */
let audio: AudioContext | undefined;

export function chime(): void {
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audio ??= new Ctor();
    void audio.resume();

    const start = audio.currentTime;
    [880, 1174.66].forEach((freq, i) => {
      const ctx = audio as AudioContext;
      const at = start + i * 0.085;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // exponentialRamp cannot touch zero, hence the near-silent floor.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.16, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.32);
    });
  } catch {
    // No audio device, or the context was refused. Silence is an acceptable
    // failure for a notification sound -- the bar still says everything.
  }
}

/**
 * Chime once when a session becomes genuinely blocked on you.
 *
 * Keyed on the permission itself, not on the render: the view is pushed every two
 * seconds, and a sound that fired on every push would be unbearable within a
 * minute. Keys are dropped when their prompt clears, so the same command blocking
 * again later is a new event and chimes again.
 *
 * Suppressed when you are already looking at the window the session belongs to --
 * the same rule the notifier applies, for the same reason. Prompts seen while the
 * sound is off are still marked as heard, so switching it on does not fire a
 * backlog of chimes for things you already dealt with.
 */
function useBlockedChime(view: RendererView | null): void {
  const heard = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!view) return;
    const live = new Set<string>();
    for (const s of view.sessions) {
      if (!s.permissionActionable || !s.permissionKey) continue;
      const id = `${s.sessionId}:${s.permissionKey}`;
      live.add(id);
      if (heard.current.has(id)) continue;
      heard.current.add(id);
      const focused = s.bridge?.focused ?? (view.bridge.focused && !s.bridge);
      if (view.sound && !focused) chime();
    }
    for (const id of [...heard.current]) if (!live.has(id)) heard.current.delete(id);
  }, [view]);
}

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
  // Also ticks while a decision is open, so its countdown moves every second
  // rather than only when a view happens to be pushed.
  const live = Boolean(session?.turnStartedAt) || Boolean(session?.decision);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [live]);
  if (!session) return 0;
  return session.turnStartedAt ? Date.now() - session.turnStartedAt : session.elapsedMs;
}

/**
 * Resize grips, drawn in the page rather than by the OS.
 *
 * A transparent frameless window gets no resize border on Windows — measured:
 * `WS_THICKFRAME` is absent whatever `resizable` is set to. Native drag-resize
 * and rounded corners cannot both exist, so the grips live here and main clamps
 * whatever they ask for.
 *
 * `screenX/Y` rather than `clientX/Y`: the window is moving underneath the
 * pointer as it resizes, so window-relative coordinates feed back on themselves.
 */
function useGrip(edge: 'left' | 'right' | 'corner'): (e: React.PointerEvent<HTMLElement>) => void {
  return useCallback((e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.screenX;
    const startY = e.screenY;
    const startW = window.innerWidth;
    const startH = window.innerHeight;
    // Without capture the drag dies the instant the cursor crosses the window
    // edge -- which is immediately, because a grip sits ON that edge and you
    // drag outward from it. Capture keeps the events coming to this element.
    const grip = e.currentTarget;
    const pointerId = e.pointerId;
    grip.setPointerCapture(pointerId);
    // Dragging an edge outward widens: the OPPOSITE edge stays put, which is
    // what makes a grip feel like a grip rather than a move handle. Read that
    // edge ONCE -- re-reading it while the window is moving chases itself.
    const anchor =
      edge === 'left'
        ? ({ side: 'right', x: window.screenX + startW } as const)
        : ({ side: 'left', x: window.screenX } as const);

    const move = (ev: PointerEvent): void => {
      const dx = edge === 'left' ? startX - ev.screenX : ev.screenX - startX;
      const width = startW + dx;
      const height = edge === 'corner' ? startH + (ev.screenY - startY) : startH;
      void window.watcher.resize(
        Math.round(width),
        Math.round(height),
        edge === 'corner' ? undefined : anchor,
      );
    };
    const up = (): void => {
      grip.releasePointerCapture(pointerId);
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }, [edge]);
}

/**
 * The bar's status light: a strip down the capsule's left edge, clipped by the
 * parent's `rounded-full overflow-hidden` into a crescent that traces the rim.
 *
 * It replaces the 8px dot that used to sit in the row. Same information, but it
 * reads at a glance from across a screen and without focusing on the bar, which
 * is the entire point of a thing you are supposed to notice peripherally.
 *
 * The colour transitions rather than cutting, so a turn ending registers as
 * movement even when you are not looking straight at it.
 */
function EdgeLight({ severity }: { severity: Severity }): JSX.Element {
  return (
    <span
      aria-hidden
      className="edge-flow pointer-events-none absolute inset-0 z-10 rounded-full"
      // The LEFT BORDER of a rounded box, not a straight strip clipped by one.
      // A strip stays a rectangle no matter what is clipping it, so it reads as
      // a line with two hard ends; a border follows the radius the whole way and
      // tapers into the rim, which is the shape the capsule already has.
      //
      // One variable is the entire state signal: the gradient, its motion and
      // its glow are all derived from it, so no state can end up with a
      // different treatment from the others by omission.
      style={{ ['--edge' as string]: EDGE_HEX[severity] } as React.CSSProperties}
    />
  );
}

type Tone = 'plain' | 'command' | 'prompt' | 'hint';

/** The pill itself. Fixed height in every tone, so a chip appearing around the
 *  text cannot make the line jump vertically -- it only fades in. */
const TONE_BOX: Record<Tone, string> = {
  plain: 'px-0',
  command: 'rounded-md bg-zinc-800/80 px-2.5',
  prompt: 'rounded-md bg-amber-500/12 px-2.5',
  hint: 'px-0',
};

/** Carried by each LINE, so an outgoing one keeps the type it left as. */
const TONE_TEXT: Record<Tone, string> = {
  plain: 'text-[11.5px] text-zinc-400',
  command: 'font-mono text-[11.5px] text-zinc-300',
  prompt: 'font-mono text-[11.5px] text-amber-100',
  hint: 'text-[11px] text-amber-300',
};

/**
 * The status line, as a ticker.
 *
 * Claude's state changes constantly -- thinking, running, reading, editing --
 * and the old behaviour was to swap the text in place. A silent substitution is
 * invisible unless you happen to be reading the bar at that instant, which is
 * exactly the wrong property for an overlay you are meant to catch out of the
 * corner of your eye.
 *
 * So the outgoing line leaves upward and the new one arrives from below, into
 * the same spot. The pill is `overflow-hidden`, the leaving line is absolute and
 * fades before the arriving one is legible, and the two never read as a stack.
 *
 * The OUTGOING line keeps the tone it was rendered with. Restyling something on
 * its way out -- a command chip turning into plain text mid-flight -- reads as a
 * glitch rather than a transition.
 */
function StatusTicker({ text, tone }: { text: string; tone: Tone }): JSX.Element {
  const [cur, setCur] = useState({ text, tone, key: 0 });
  const [prev, setPrev] = useState<typeof cur | null>(null);

  useEffect(() => {
    setCur((c) => {
      if (c.text === text && c.tone === tone) return c;
      setPrev(c);
      return { text, tone, key: c.key + 1 };
    });
  }, [text, tone]);

  return (
    // The outer cell is flex-1 and never changes size, so the clock and the
    // buttons to its right cannot be pushed around by a longer message. Only
    // the pill inside it grows, and it grows into space that is already spoken
    // for.
    <span className="flex min-w-0 flex-1 items-center">
      <span
        className={`tick relative flex h-[26px] items-center overflow-hidden ${TONE_BOX[tone]}`}
        title={text}
      >
        {prev && (
          <span
            key={prev.key}
            aria-hidden
            className={`tick__line tick__line--out flex items-center truncate ${TONE_TEXT[prev.tone]}`}
            onAnimationEnd={() => setPrev(null)}
          >
            {prev.text}
          </span>
        )}
        <span
          key={cur.key}
          className={`tick__line tick__line--in min-w-0 truncate ${TONE_TEXT[cur.tone]}`}
        >
          {cur.text}
        </span>
      </span>
    </span>
  );
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
  // A live decision counts as actionable regardless of the grace window: if we
  // can answer it, the card must show it, or the bar would offer Allow/Deny while
  // the expanded card showed nothing for the first 700ms.
  const p = session.permissionActionable || session.decision
    ? session.pendingPermission
    : undefined;
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
        {session.decision ? (
          <>
            <button
              type="button"
              className="no-drag rounded-md bg-emerald-400 px-2.5 py-1 text-[11px] font-semibold text-emerald-950 transition hover:bg-emerald-300"
              onClick={() => void window.watcher.decide(session.sessionId, 'allow')}
            >
              Allow
            </button>
            <button
              type="button"
              className="no-drag rounded-md border border-rose-500/50 px-2.5 py-1 text-[11px] font-semibold text-rose-300 transition hover:bg-rose-500/10"
              onClick={() => void window.watcher.decide(session.sessionId, 'deny')}
            >
              Deny
            </button>
            <span className="font-mono text-[10px] tabular-nums text-zinc-500">
              {Math.max(0, Math.ceil((session.decision.expiresAt - Date.now()) / 1000))}s
            </span>
          </>
        ) : (
          <button
            type="button"
            className="no-drag rounded-md bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-900 transition hover:bg-white"
            onClick={() => open(session.sessionId)}
          >
            Open VS Code
          </button>
        )}
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
          <li key={a.id} className="row-in flex items-start gap-2 rounded px-0.5 py-0.5 text-[11px]">
            <span
              className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${
                a.status === 'failed' ? 'bg-rose-500'
                  : a.status === 'running' ? 'bg-emerald-400 dot-live' : 'bg-zinc-600'
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
          <li key={f} className="row-in truncate px-0.5 font-mono text-[10.5px] text-zinc-400">{f}</li>
        ))}
      </ul>
    </div>
  );
}

const RANGES = [
  { label: '7d', days: 7 },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
] as const;

/** Compact duration for axis labels and totals: 0s, 45s, 6m, 2h 10m. */
function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * What the overlay bought you, from your own two populations of prompts.
 *
 * Every prompt ends up in exactly one of them: answered from the bar, or
 * resolved somewhere we cannot see (VS Code, the terminal). Both carry the wait
 * from the prompt arriving to it being settled, so the difference of the means
 * is the per-prompt saving -- measured against your own habits, not a number
 * someone picked.
 *
 * It returns null rather than a small number when either population is thin. A
 * "saving" computed from one sample of each is noise wearing a decimal point.
 */

/**
 * The same range again, immediately before it — so "12m" can become "12m, down
 * from 20m". A total on its own does not answer the only question anyone asks
 * of it, which is whether things are getting better.
 *
 * Returns null unless the whole previous window is present in the retained 30
 * days, and unless it is non-zero: a percentage against nothing is a division
 * by zero dressed as an insight.
 */

function Analysis({ onClose }: { onClose: () => void }): JSX.Element {
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [range, setRange] = useState<number>(7);

  useEffect(() => {
    void window.watcher.stats().then(setStats);
  }, []);

  const all = stats?.days ?? [];
  const days = all.slice(-range);
  const move = trend(all, range);

  // What Claude keeps asking about, most-asked first. Summed across the range
  // rather than per day, because the point is the pattern, not when it happened.
  const asked = Object.entries(
    days.reduce<Record<string, number>>((acc, d) => {
      for (const [k, n] of Object.entries(d.commands)) acc[k] = (acc[k] ?? 0) + n;
      return acc;
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const counts = days.map((d) => d.counts);
  const peak = Math.max(1, ...days.map((d) => d.blockedMs));
  const total = counts.reduce(
    (acc, c) => ({
      prompts: acc.prompts + c.prompts,
      tools: acc.tools + c.tools,
      turns: acc.turns + c.turns,
      sessions: acc.sessions + c.sessions,
    }),
    { prompts: 0, tools: 0, turns: 0, sessions: 0 },
  );
  const blocked = days.reduce((a, d) => a + d.blockedMs, 0);
  const saved = savings(counts);

  return (
    // A scrolling BLOCK, not a flex column. In a flex column every child is
    // shrinkable by default, so making the card shorter squeezed the chart down
    // to a row of dashes and eventually to nothing -- the panel gave away the
    // one thing it exists to show in order to keep the numbers below it on
    // screen. Block layout gives each child its natural height and scrolls.
    <div className="absolute inset-0 z-10 overflow-y-auto bg-zinc-950 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-zinc-200">Analysis</span>
        <button type="button" className="no-drag text-[11px] text-zinc-500 hover:text-zinc-200" onClick={onClose}>
          close
        </button>
      </div>

      <div className="mt-2 flex gap-1">
        {RANGES.map((r) => (
          <button
            key={r.label}
            type="button"
            onClick={() => setRange(r.days)}
            className={`no-drag rounded px-2 py-0.5 text-[10px] ${
              range === r.days ? 'bg-zinc-100 text-zinc-900' : 'border border-zinc-800 text-zinc-400 hover:text-zinc-100'
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Waiting per day. One bar per day including the empty ones -- dropping a
          quiet day would silently rescale the axis and make a quiet week look
          exactly like a busy one. */}
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wider text-zinc-600">Claude waiting on you</span>
        {move && (
          // Down is good here: the number is time you cost Claude, not time you
          // earned. Green for a fall, amber for a rise.
          <span
            className={`ml-auto font-mono text-[10px] tabular-nums ${
              move.delta < 0 ? 'text-emerald-400/90' : 'text-amber-400/90'
            }`}
            title={`Previous ${range} days: ${dur(move.prev)}`}
          >
            {move.delta < 0 ? '▼' : '▲'} {Math.abs(Math.round(move.delta * 100))}% vs prev {range}d
          </span>
        )}
      </div>
      {/* shrink-0 as well as block layout above: whatever this ends up nested
          in, the chart keeps its 96px. It is the point of the panel. */}
      <div className="mt-1.5 flex h-24 shrink-0 items-end gap-[2px]">
        {days.map((d) => (
          <div
            key={d.date}
            title={`${d.date} — ${dur(d.blockedMs)}`}
            className="flex-1 rounded-sm bg-amber-400/70 transition-[height] duration-300 hover:bg-amber-300"
            style={{ height: `${Math.max(d.blockedMs > 0 ? 3 : 1, (d.blockedMs / peak) * 100)}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-zinc-600">
        <span>{days[0]?.date.slice(5)}</span>
        <span>peak {dur(peak)}</span>
        <span>{days[days.length - 1]?.date.slice(5)}</span>
      </div>

      <div className="mt-3 rounded border border-zinc-800 p-2">
        <div className="text-[10px] uppercase tracking-wider text-zinc-600">Time saved</div>
        {saved ? (
          <>
            <div className="mt-0.5 font-mono text-[15px] tabular-nums text-emerald-400">{dur(saved.total)}</div>
            <p className="mt-1 text-[9.5px] leading-relaxed text-zinc-500">
              {dur(saved.perPrompt)} per prompt × {saved.answered} answered here, against your own{' '}
              {saved.elsewhere} settled in VS Code instead.
            </p>
            <p className="mt-1.5 text-[9px] leading-relaxed text-zinc-600">
              An estimate, not a measurement. Each prompt is credited once when it resolves and
              never recounted, so this only ever grows. A prompt you answered slower than your VS
              Code average counts zero, not a negative — a sum of savings, not a net. The groups
              are self-selected rather than assigned, and a grant in VS Code fires no hook, so its
              wait is read from the tool starting: tens of ms late, which flatters this figure.
            </p>
          </>
        ) : (
          <p className="mt-1 text-[9.5px] leading-relaxed text-zinc-500">
            Needs at least {MIN_SAMPLES} prompts answered here and {MIN_SAMPLES} settled in VS Code
            in this range — so it needs Allow/Deny turned on. Until both groups exist there is
            nothing to compare, and a figure from one of each would be noise. Nothing is estimated
            in the meantime.
          </p>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {[
          ['Waiting on you', dur(blocked)],
          ['Prompts', String(total.prompts)],
          ['Tool calls', String(total.tools)],
          ['Turns', String(total.turns)],
        ].map(([label, value]) => (
          <div key={label} className="rounded border border-zinc-800 p-2">
            <div className="text-[9.5px] uppercase tracking-wider text-zinc-600">{label}</div>
            <div className="mt-0.5 font-mono text-[13px] tabular-nums text-zinc-200">{value}</div>
          </div>
        ))}
      </div>

      {/* The one statistic here you can act on. Everything else describes what
          happened; this says what to change so it stops happening. */}
      {asked.length > 0 && (
        <div className="mt-3 rounded border border-zinc-800 p-2">
          <div className="text-[10px] uppercase tracking-wider text-zinc-600">Keeps asking about</div>
          <div className="mt-1.5 space-y-1">
            {asked.map(([key, n]) => (
              <div key={key} className="flex items-baseline gap-2">
                <span className="truncate font-mono text-[11px] text-zinc-300">{key}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-zinc-500">
                  ×{n}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[9px] leading-relaxed text-zinc-600">
            Anything here that you always approve belongs in your Claude Code permission
            allowlist — then it stops interrupting you at all.
          </p>
        </div>
      )}

      <p className="mt-3 text-[9.5px] leading-relaxed text-zinc-600">
        Every figure here is a tally of hook events that actually arrived, kept for 30 days on this
        machine and sent nowhere. Commands are stored as a program name and at most one subcommand,
        never the arguments.
      </p>
    </div>
  );
}

/** A labelled group. Sections are the whole navigation — there are no tabs. */
function Group({ title, note, children }: {
  title: string; note?: string; children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="mt-3 rounded border border-zinc-800 p-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-600">{title}</div>
      {note && <p className="mt-1 text-[9.5px] leading-relaxed text-zinc-600">{note}</p>}
      <div className="mt-2 space-y-2">{children}</div>
    </div>
  );
}

function Toggle({ label, note, checked, onChange }: {
  label: string; note?: string; checked: boolean; onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label className="no-drag flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3 w-3 shrink-0 accent-amber-400"
      />
      <span className="min-w-0">
        <span className="block text-[11px] text-zinc-300">{label}</span>
        {note && <span className="mt-0.5 block text-[9.5px] leading-relaxed text-zinc-600">{note}</span>}
      </span>
    </label>
  );
}

/** Seconds in, milliseconds out — nobody wants to think in ms. */
function Seconds({ label, note, value, min, max, step = 1, onCommit }: {
  label: string; note?: string; value: number;
  min: number; max: number; step?: number; onCommit: (ms: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(String(Math.round(value / 1000)));
  useEffect(() => setDraft(String(Math.round(value / 1000))), [value]);
  const commit = (): void => {
    const n = Number(draft);
    if (!Number.isFinite(n)) return void setDraft(String(Math.round(value / 1000)));
    const ms = Math.min(max, Math.max(min, Math.round(n))) * 1000;
    onCommit(ms);
  };
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] text-zinc-300">{label}</span>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          className="no-drag w-14 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-right font-mono text-[11px] tabular-nums text-zinc-200"
        />
        <span className="font-mono text-[10px] text-zinc-600">s</span>
      </div>
      {note && <p className="mt-1 text-[9.5px] leading-relaxed text-zinc-600">{note}</p>}
    </div>
  );
}

/**
 * Settings, with hook installation folded in as one section of it.
 *
 * The panel does the work the config file used to make you do by hand, and it
 * owns the CONSEQUENCES of each change rather than leaving them to drift
 * detection: switching decisions on rewrites the installed hooks in place,
 * because the timeout lives inside them, and changing the port says plainly that
 * it needs a restart instead of appearing to have worked.
 */
function Settings({ onClose }: { onClose: () => void }): JSX.Element {
  const [status, setStatus] = useState<HookStatusPayload | null>(null);
  const [cfg, setCfg] = useState<SettingsPayload | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);

  const refresh = useCallback(() => {
    void window.watcher.hooks.status().then(setStatus);
    void window.watcher.settings.get().then(setCfg);
  }, []);
  useEffect(refresh, [refresh]);

  // Every write goes through here, so the CONSEQUENCES of a change are reported
  // in one place rather than remembered at each call site.
  const save = useCallback((patch: Partial<SettingsPayload>) => {
    setCfg((c) => (c ? { ...c, ...patch } : c));
    void window.watcher.settings.set(patch).then((r) => {
      const bits: string[] = [];
      if (r.reinstalled.length) bits.push(`hooks reinstalled (${r.reinstalled.join(', ')})`);
      if (r.restartRequired) bits.push('restart required for the new port');
      setNote(bits.length ? bits.join(' · ') : null);
      refresh();
    });
  }, [refresh]);

  return (
    <div className="absolute inset-0 z-10 flex flex-col overflow-y-auto bg-zinc-950 p-3">
      <div className="sticky top-0 flex items-center justify-between bg-zinc-950 pb-1">
        <span className="text-[11px] font-medium text-zinc-200">Settings</span>
        <button type="button" className="no-drag text-[11px] text-zinc-500 hover:text-zinc-200" onClick={onClose}>
          close
        </button>
      </div>

      {note && (
        <p className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-200">
          {note}
        </p>
      )}

      {status && (
        <Group
          title="Hooks"
          note={`Sidelong listens on 127.0.0.1:${status.port} and installs Claude Code hooks that POST there. Nothing leaves this machine.`}
        >
          {status.message && (
            <p className="rounded border border-amber-500/30 bg-amber-500/10 p-1.5 text-[10px] text-amber-200">
              {status.message}
            </p>
          )}
          {(['user', 'project'] as const).map((scope) => (
            <div key={scope} className="rounded border border-zinc-800 p-1.5">
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
          <p className="text-[9.5px] text-zinc-600">
            Verify inside Claude Code with <span className="font-mono text-zinc-500">/hooks</span>. Closing
            Sidelong never affects a running session.
          </p>
        </Group>
      )}

      {cfg && (
        <>
          <Group
            title="Permission decisions"
            note="Off by default. It changes what this app is: a watcher gains the ability to approve a command. Turning it on, or moving the window, rewrites the installed hooks — the timeout lives inside them."
          >
            <Toggle
              label="Answer prompts from the bar"
              note="Adds Allow / Deny. While a decision is outstanding the tool call is blocked and VS Code's own prompt does not appear, so ignoring the bar delays the normal prompt."
              checked={cfg.permissionDecisions}
              onChange={(v) => save({ permissionDecisions: v })}
            />
            {cfg.permissionDecisions && (
              <Seconds
                label="Decision window"
                note="The longest this app can ever stall one tool call. When it lapses Claude Code prompts you normally — nothing is lost."
                value={cfg.decisionWindowMs}
                min={3}
                max={60}
                onCommit={(ms) => save({ decisionWindowMs: ms })}
              />
            )}
          </Group>

          <Group title="Behaviour">
            <Toggle
              label="Desktop notifications"
              note="A toast when a session needs you, finishes, or fails. On by default — a permission prompt nobody sees is the problem this app exists for. Turning it off leaves the bar working; it just stops interrupting whatever is in front of you."
              checked={cfg.notifications}
              onChange={(v) => save({ notifications: v })}
            />
            <div>
              <Toggle
                label="Sound when a session blocks"
                note="A short chime, only for a prompt that is genuinely waiting on you — never for ordinary activity. Off by default. Silent while you are already looking at that session's VS Code window."
                checked={cfg.sound}
                onChange={(v) => save({ sound: v })}
              />
              <button
                type="button"
                className="no-drag ml-5 mt-1 rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-100"
                onClick={() => chime()}
              >
                Play it
              </button>
            </div>
            <Toggle
              label="Start with Windows"
              checked={cfg.openAtLogin}
              onChange={(v) => save({ openAtLogin: v })}
            />
            <Seconds
              label="Call it stale after"
              note="How long silence lasts before the bar stops claiming Claude is working and says how long it has been instead. It never changes the status — only what it admits to knowing."
              value={cfg.staleMs}
              min={15}
              max={600}
              onCommit={(ms) => save({ staleMs: ms })}
            />
            <Seconds
              label="Collapse when done after"
              note="0 keeps the card open until you close it."
              value={cfg.completedDismissMs}
              min={0}
              max={300}
              onCommit={(ms) => save({ completedDismissMs: ms })}
            />
          </Group>

          <Group title="Data" note={`Kept in ${cfg.dataDir}, and sent nowhere.`}>
            <Toggle
              label="Write a debug log"
              note="Records every hook event to disk, INCLUDING tool inputs — which carry whole file contents and full command strings. Off by default for exactly that reason. Turn it on while chasing something, then turn it off."
              checked={cfg.debugLog}
              onChange={(v) => save({ debugLog: v })}
            />
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                className="no-drag rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-100"
                onClick={() => void window.watcher.settings.openDataDir()}
              >
                Open folder
              </button>
              {confirmWipe ? (
                <>
                  <button
                    type="button"
                    className="no-drag rounded bg-rose-500/90 px-2 py-0.5 text-[10px] text-white hover:bg-rose-500"
                    onClick={() => {
                      void window.watcher.settings.clearStats().then(() => {
                        setConfirmWipe(false);
                        setNote('statistics cleared');
                      });
                    }}
                  >
                    Delete 30 days — sure?
                  </button>
                  <button
                    type="button"
                    className="no-drag rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400"
                    onClick={() => setConfirmWipe(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="no-drag rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-rose-300"
                  onClick={() => setConfirmWipe(true)}
                >
                  Clear statistics
                </button>
              )}
            </div>
          </Group>

          <Group title="About">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] text-zinc-300">Sidelong</span>
              <span className="font-mono text-[11px] tabular-nums text-zinc-500">v{cfg.version}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[10.5px] text-zinc-500">Listening on</span>
              <span className="font-mono text-[10.5px] text-zinc-500">127.0.0.1:{cfg.port}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-[10.5px] text-zinc-500">Shortcut</span>
              <span className="font-mono text-[10.5px] text-zinc-500">{cfg.shortcut}</span>
            </div>
            <p className="text-[9.5px] leading-relaxed text-zinc-600">
              Port and shortcut are still edited in config.json. The port because every installed
              hook points at it and moving it needs a restart; the shortcut because capturing a
              chord safely is a job of its own.
            </p>
          </Group>
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
  const gripLeft = useGrip('left');
  const gripRight = useGrip('right');
  const a = view.active;
  const severity: Severity = a?.severity ?? 'offline';
  // While we can actually ANSWER the prompt, Allow/Deny replaces the
  // acknowledge pair entirely. Showing both would offer four buttons for one
  // decision, and the hidden pair would still be clickable and tab-reachable
  // underneath the overlaid group.
  const deciding = Boolean(a?.decision);
  // permissionActionable, NOT pendingPermission: a prompt about to be
  // auto-approved must not put buttons in front of you for a command that is
  // already running.
  const pending = !deciding && a?.permissionActionable ? a.pendingPermission : undefined;
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
      <EdgeLight severity={severity} />

      {/* Width-only grips on BOTH edges -- reaching for either one is the
          instinct, and a grip you have to guess the side of is not a grip.
          Each anchors the opposite edge, so the capsule grows away from the
          side you grabbed instead of sliding across the screen. */}
      <span
        onPointerDown={gripLeft}
        title="Drag to resize"
        className="absolute inset-y-0 left-0 z-20 w-3 cursor-ew-resize"
        // Inline, not just the .no-drag class: window dragging is resolved in the
        // compositor before JS runs, so if this region is draggable the pointer
        // moves the window and the grip never sees the event.
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      />
      <span
        onPointerDown={gripRight}
        title="Drag to resize"
        className="absolute inset-y-0 right-0 z-20 w-3 cursor-ew-resize"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      />

      <span className="flex shrink-0 items-center gap-2 pl-1.5">
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
      <StatusTicker
        text={hint ?? headline ?? 'Waiting for a Claude Code session.'}
        tone={hint ? 'hint' : asCommand || deciding ? (pending ? 'prompt' : 'command') : 'plain'}
      />

      <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-400">
        {a && (a.turnStartedAt ?? a.elapsedMs) ? clock(elapsed) : ''}
      </span>

      {/* Hook drift lives in the expanded card now, in words. A bare ⚠ on the
          capsule read as "your code has a problem" -- it means neither that nor
          anything about the session it sat next to, only that OUR hooks are out
          of date. An icon that makes you open something to find out what it
          means has already failed at being an icon. */}
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
      <span
        aria-hidden={!deciding}
        className={`pointer-events-none absolute inset-y-0 right-7 z-10 flex items-center gap-1.5 pl-10 transition-all duration-200 ease-out ${
          deciding ? 'translate-x-0 opacity-100' : 'translate-x-1 opacity-0'
        }`}
        style={{
          background:
            'linear-gradient(to right, rgba(9,9,11,0) 0%, rgba(9,9,11,0.97) 38%, rgba(9,9,11,0.97) 100%)',
        }}
      >
        <span className="font-mono text-[10px] tabular-nums text-zinc-500">
          {a?.decision ? `${Math.max(0, Math.ceil((a.decision.expiresAt - Date.now()) / 1000))}s` : ''}
        </span>
        <button
          type="button"
          tabIndex={deciding ? 0 : -1}
          title="Run it. This actually approves the tool call."
          className={`no-drag rounded-md bg-emerald-400 px-2.5 py-1 text-[11px] font-semibold text-emerald-950 transition hover:bg-emerald-300 ${
            deciding ? 'pointer-events-auto' : ''
          }`}
          onClick={() => a?.decision && void window.watcher.decide(a.sessionId, 'allow')}
        >
          Allow
        </button>
        <button
          type="button"
          tabIndex={deciding ? 0 : -1}
          title="Refuse it. Claude is told the call was denied."
          className={`no-drag rounded-md border border-rose-500/50 px-2.5 py-1 text-[11px] font-semibold text-rose-300 transition hover:bg-rose-500/10 ${
            deciding ? 'pointer-events-auto' : ''
          }`}
          onClick={() => a?.decision && void window.watcher.decide(a.sessionId, 'deny')}
        >
          Deny
        </button>
      </span>

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

function ConnectionRow({ view, onFix }: { view: RendererView; onFix: () => void }): JSX.Element {
  const bridge = view.bridge.status;
  const bridgeDot = bridge === 'connected' ? 'bg-emerald-400'
    : bridge === 'reconnecting' ? 'bg-amber-400' : 'bg-zinc-600';
  return (
    // No `mt-auto` here: the action row above it already claims the free space.
    // With both set, flex splits the gap between them and the buttons end up
    // stranded in the middle of the card instead of against the footer.
    <div className="border-t border-zinc-800/80 px-2.5 py-1.5 text-[10px] text-zinc-500">
      {/* Drift is the one condition here that makes everything BELOW it
          untrustworthy: the hooks Claude Code has installed no longer match the
          ones this app expects, so the overlay can go quietly out of date.
          It gets its own line -- squeezed into the status row it pushed
          "Hooks listening" onto two lines and truncated the bridge label to
          "VS Code bri…", which is a worse problem than the one it reports.
          It is a button, because "reinstall" should not be a dead end. */}
      {view.hookConfigDrift && (
        <button
          type="button"
          onClick={onFix}
          title={view.hookConfigDrift}
          className="no-drag mb-1 block w-full truncate text-left text-amber-400/90 hover:text-amber-300"
        >
          Hooks out of date — reinstall
        </button>
      )}
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${view.ingestReady ? 'bg-emerald-400' : 'bg-rose-500'}`}
        />
        <span className="shrink-0 whitespace-nowrap">
          {view.ingestReady ? 'Hooks listening' : 'Receiver down'}
        </span>
        <span className="shrink-0 text-zinc-700">·</span>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${bridgeDot}`} />
        <span className="truncate">
          {bridge === 'connected' ? 'VS Code bridge' : 'VS Code bridge not connected'}
        </span>
        {!view.sessions.length && view.ingestReady && (
          <span className="ml-auto shrink-0 text-zinc-600">no session</span>
        )}
      </div>
    </div>
  );
}

export default function App(): JSX.Element {
  const [view, setView] = useState<RendererView | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const cornerGrip = useGrip('corner');

  useEffect(() => {
    void window.watcher.getView().then(setView);
    return window.watcher.onView(setView);
  }, []);

  useBlockedChime(view);

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

        {/* Actions sit at the BOTTOM, against the status footer. Up under the
            summary they split the card in two and left the timeline floating in
            the middle of a page of empty space -- and controls belong at the
            edge you reach for, not in the middle of what you are reading.
            `mt-auto` puts them there however tall the card is dragged. */}
        {/* No "Open VS Code" here on purpose.
            On the capsule the button is unambiguous -- one session is on screen
            and the button focuses THAT session's window. Down here it sits in a
            row of app-wide controls next to Settings, Analysis and Quit, where it
            reads as "open VS Code" generally, and nothing on the row tells you
            which window or file it would raise. A control whose target you cannot
            see is not a control, it is a guess. It stays on the bar, where the
            session it belongs to is the thing you are looking at. */}
        <div className="mt-auto flex items-center gap-2 px-2.5 pb-1.5 pt-3">
          <button
            type="button"
            className="no-drag rounded border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-200"
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </button>
          <button
            type="button"
            className="no-drag rounded border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-200"
            onClick={() => setAnalysisOpen(true)}
          >
            Analysis
          </button>
          <button
            type="button"
            className="no-drag ml-auto text-[10px] text-zinc-700 hover:text-zinc-400"
            onClick={() => void window.watcher.quit()}
          >
            Quit
          </button>
        </div>

        <ConnectionRow view={view} onFix={() => setSettingsOpen(true)} />
        {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
        {analysisOpen && <Analysis onClose={() => setAnalysisOpen(false)} />}
      </div>

      {/* Both-axis grip in the bottom-right corner, where one belongs. */}
      <span
        onPointerDown={cornerGrip}
        title="Drag to resize"
        className="absolute bottom-0 right-0 z-20 h-5 w-5 cursor-nwse-resize"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <svg viewBox="0 0 16 16" className="absolute bottom-[3px] right-[3px] h-2.5 w-2.5" aria-hidden="true">
          <path d="M15 7 L7 15 M15 11 L11 15" stroke="currentColor" strokeWidth="1.4"
                className="text-zinc-600" strokeLinecap="round" fill="none" />
        </svg>
      </span>
    </div>
  );
}
