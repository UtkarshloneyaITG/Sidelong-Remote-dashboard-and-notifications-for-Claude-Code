/**
 * Desktop notifications.
 *
 * Notify on: permission required, waiting for input, completed, failed, and an
 * unexpected disconnect. Never on individual file reads or edits -- that is the
 * fastest way to make someone mute the app.
 *
 * The important suppression is VS Code focus: if you are already looking at the
 * window, a toast telling you what is on your screen is pure noise.
 */

import { Notification } from 'electron';
import type { OverlayView, SessionView, Status } from '@agent-watcher/protocol';

/** One notification per (session, status) transition, at most this often. */
const THROTTLE_MS = 3_000;

const NOTIFY_ON: ReadonlySet<Status> = new Set<Status>([
  'WAITING_FOR_PERMISSION', 'WAITING_FOR_INPUT', 'COMPLETED', 'ERROR',
]);

/** "4m 12s" / "45s" — a toast is read at a glance, not parsed. */
function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Windows toast layout: ONE bold title line, then up to ~2 wrapped body lines.
 *
 * So the title carries "what happened, and where" — scannable without reading —
 * and the body carries the specific: the actual command, the actual error, the
 * actual summary. Metadata (files changed, elapsed) goes on a second body line
 * rather than being crammed into the title, which is what made the old toast
 * unreadable at a glance.
 */
export function format(s: SessionView): { title: string; body: string } {
  const where = s.project ? ` — ${s.project}` : '';
  const clip = (t: string | undefined, n = 160): string => (t ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

  switch (s.status) {
    case 'WAITING_FOR_PERMISSION': {
      const p = s.pendingPermission;
      return {
        title: `Permission needed${where}`,
        body: clip(p?.detail) || 'Claude is waiting for your approval.',
      };
    }
    case 'WAITING_FOR_INPUT':
      return { title: `Waiting for you${where}`, body: clip(s.message) || 'Claude needs your input.' };

    case 'COMPLETED': {
      const meta = [
        s.filesChanged.length
          ? `${s.filesChanged.length} file${s.filesChanged.length === 1 ? '' : 's'} changed`
          : '',
        s.elapsedMs > 0 ? humanDuration(s.elapsedMs) : '',
      ].filter(Boolean).join(' · ');
      const summary = clip(s.message, 140) || 'Done.';
      return { title: `Finished${where}`, body: meta ? `${summary}\n${meta}` : summary };
    }
    case 'ERROR': {
      const detail = clip(s.error?.detail ?? s.details, 140);
      // s.message is already the human error class ("Rate limited").
      return { title: `Failed${where}`, body: detail ? `${s.message}\n${detail}` : s.message };
    }
    default:
      return { title: `Claude${where}`, body: clip(s.message) };
  }
}

interface Sent {
  status: Status;
  at: number;
  /** Distinguishes two different permission prompts in the same session. */
  key: string;
}

export class Notifier {
  private last = new Map<string, Sent>();

  constructor(
    private readonly onActivate: (sessionId: string) => void,
    /** App mark for the toast. Without it Windows shows the stock Electron icon. */
    private readonly iconPath?: string,
  ) {}

  /**
   * Called with each new view. Fires only on a genuine status TRANSITION, so a
   * view pushed for an unrelated reason cannot re-notify.
   */
  update(view: OverlayView): void {
    for (const s of view.sessions) this.consider(s, view);
  }

  private consider(s: SessionView, view: OverlayView): void {
    // A permission that has not outlived the grace period is very likely about
    // to be auto-approved. Notifying on it produced the worst bug in this app:
    // a toast that lingers in the Action Center telling you to open VS Code for
    // a command that already ran. Wait until the prompt proves it is real.
    if (s.status === 'WAITING_FOR_PERMISSION' && !s.permissionActionable) return;

    if (!NOTIFY_ON.has(s.status)) {
      // Remember the non-notifying status so returning to a notifying one counts
      // as a fresh transition.
      this.last.set(s.sessionId, { status: s.status, at: Date.now(), key: '' });
      return;
    }
    const key = s.pendingPermission ? `${s.pendingPermission.tool}:${s.pendingPermission.at}` : s.message;
    const prev = this.last.get(s.sessionId);
    const now = Date.now();
    if (prev && prev.status === s.status && prev.key === key) return;
    if (prev && now - prev.at < THROTTLE_MS && prev.status === s.status) return;
    this.last.set(s.sessionId, { status: s.status, at: now, key });

    // Already looking at the window this session belongs to? Say nothing.
    const focused = s.bridge?.focused ?? (view.bridge.focused && !s.bridge);
    if (focused) return;

    const { title, body } = format(s);
    const n = new Notification({
      title,
      body,
      icon: this.iconPath,
      // Permission and failure must not evaporate while you are in another app.
      timeoutType: s.status === 'WAITING_FOR_PERMISSION' || s.status === 'ERROR'
        ? 'never'
        : 'default',
      urgency: s.status === 'WAITING_FOR_PERMISSION' || s.status === 'ERROR' ? 'critical' : 'normal',
      silent: s.status === 'COMPLETED',
    });
    n.on('click', () => this.onActivate(s.sessionId));
    n.show();
  }

  forget(sessionId: string): void {
    this.last.delete(sessionId);
  }
}
