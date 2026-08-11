/**
 * The whole renderer API surface.
 *
 * Note what is NOT here: there is no channel that sets an agent status, injects
 * an event, or fakes a state. The renderer can resize itself, ask VS Code for
 * focus, and manage hook installation. That is the structural guarantee behind
 * "the UI cannot be driven by nothing" -- it has nothing to drive it with.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { OverlayView } from '@sidelong/protocol';

export type RendererView = OverlayView & { expanded: boolean; sound: boolean };

const api = {
  /** Push subscription. Returns an unsubscribe. */
  onView(cb: (view: RendererView) => void): () => void {
    const listener = (_e: unknown, view: RendererView): void => cb(view);
    ipcRenderer.on('view', listener);
    return () => {
      ipcRenderer.off('view', listener);
    };
  },
  getView: (): Promise<RendererView> => ipcRenderer.invoke('ui:get-view'),
  setExpanded: (expanded: boolean): Promise<void> => ipcRenderer.invoke('ui:set-expanded', expanded),
  /** Focus VS Code for a session. Takes a sessionId, never a path. */
  openEditor: (sessionId?: string): Promise<{ via: string }> =>
    ipcRenderer.invoke('ui:open-editor', sessionId),
  /** "Seen it" -- shrinks the bar. Sends nothing to Claude Code. */
  acknowledge: (sessionId: string, key: string): Promise<void> =>
    ipcRenderer.invoke('ui:acknowledge', sessionId, key),
  /**
   * Answer a held permission prompt. The ONLY channel here that can cause
   * something to run -- and only when permissionDecisions is enabled in config,
   * and only for a request Claude Code is already waiting on. It names no
   * command and carries no path: just a session and one of three fixed verbs.
   */
  decide: (sessionId: string, behavior: 'allow' | 'deny' | 'defer'): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('ui:decide', sessionId, behavior),
  quit: (): Promise<void> => ipcRenderer.invoke('ui:quit'),
  /** Read-only: the banked per-day tallies behind the Analysis panel. */
  stats: (): Promise<unknown> => ipcRenderer.invoke('ui:stats'),
  /**
   * Resize from a grip. Geometry only; clamped per mode in main. `anchor` is the
   * screen edge that must hold still, read once when the drag began.
   */
  resize: (
    width: number,
    height: number,
    anchor?: { side: 'left' | 'right'; x: number },
  ): Promise<void> => ipcRenderer.invoke('ui:resize', width, height, anchor),
  /**
   * Settings. Reads and writes the user's own preferences and nothing else --
   * the token is never returned, and there is still no channel here that can set
   * an agent status.
   */
  settings: {
    get: (): Promise<unknown> => ipcRenderer.invoke('settings:get'),
    set: (patch: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('settings:set', patch),
    clearStats: (): Promise<unknown> => ipcRenderer.invoke('settings:clear-stats'),
    openDataDir: (): Promise<unknown> => ipcRenderer.invoke('settings:open-data-dir'),
  },
  hooks: {
    status: (): Promise<unknown> => ipcRenderer.invoke('hooks:status'),
    install: (scope: 'user' | 'project'): Promise<unknown> => ipcRenderer.invoke('hooks:install', scope),
    uninstall: (scope: 'user' | 'project'): Promise<unknown> => ipcRenderer.invoke('hooks:uninstall', scope),
  },
};

contextBridge.exposeInMainWorld('watcher', api);

export type WatcherApi = typeof api;
