/**
 * The whole renderer API surface.
 *
 * Note what is NOT here: there is no channel that sets an agent status, injects
 * an event, or fakes a state. The renderer can resize itself, ask VS Code for
 * focus, and manage hook installation. That is the structural guarantee behind
 * "the UI cannot be driven by nothing" -- it has nothing to drive it with.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { OverlayView } from '@agent-watcher/protocol';

export type RendererView = OverlayView & { expanded: boolean };

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
  hooks: {
    status: (): Promise<unknown> => ipcRenderer.invoke('hooks:status'),
    install: (scope: 'user' | 'project'): Promise<unknown> => ipcRenderer.invoke('hooks:install', scope),
    uninstall: (scope: 'user' | 'project'): Promise<unknown> => ipcRenderer.invoke('hooks:uninstall', scope),
  },
};

contextBridge.exposeInMainWorld('watcher', api);

export type WatcherApi = typeof api;
