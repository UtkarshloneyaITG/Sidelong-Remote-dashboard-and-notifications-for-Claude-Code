/**
 * VS Code bridge protocol. Enrichment only -- the bridge cannot observe Claude
 * Code's internal state, and the overlay is fully functional without it.
 */

import { PROTOCOL_VERSION } from './events.js';

export interface BridgeHello {
  type: 'hello';
  protocolVersion: number;
  token: string;
  vscodeVersion?: string;
}

export interface BridgeUpdate {
  type: 'update';
  protocolVersion: number;
  workspaceFolders: string[];
  activeFile?: string;
  language?: string;
  gitBranch?: string;
  focused: boolean;
  diagnostics: { errors: number; warnings: number };
}

export interface BridgePing {
  type: 'ping';
}

export type BridgeMessage = BridgeHello | BridgeUpdate | BridgePing;

/** Server -> extension. `focus` asks VS Code to bring itself to the front. */
export type BridgeCommand = { type: 'welcome' } | { type: 'focus' } | { type: 'pong' };

/**
 * Schema validation for everything inbound (spec section 8). Hand-written rather
 * than zod: it is four shapes, and a validation dependency in a package that
 * must stay dependency-free is not worth it.
 */
export function parseBridgeMessage(raw: unknown): BridgeMessage | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'not an object' };
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ping':
      return { type: 'ping' };
    case 'hello':
      if (m.protocolVersion !== PROTOCOL_VERSION) {
        return { error: `protocol ${String(m.protocolVersion)} != ${PROTOCOL_VERSION}` };
      }
      if (typeof m.token !== 'string') return { error: 'missing token' };
      return {
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        token: m.token,
        vscodeVersion: typeof m.vscodeVersion === 'string' ? m.vscodeVersion : undefined,
      };
    case 'update': {
      if (m.protocolVersion !== PROTOCOL_VERSION) {
        return { error: `protocol ${String(m.protocolVersion)} != ${PROTOCOL_VERSION}` };
      }
      const folders = Array.isArray(m.workspaceFolders)
        ? m.workspaceFolders.filter((f): f is string => typeof f === 'string')
        : [];
      const d = (m.diagnostics ?? {}) as Record<string, unknown>;
      return {
        type: 'update',
        protocolVersion: PROTOCOL_VERSION,
        workspaceFolders: folders,
        activeFile: typeof m.activeFile === 'string' ? m.activeFile : undefined,
        language: typeof m.language === 'string' ? m.language : undefined,
        gitBranch: typeof m.gitBranch === 'string' ? m.gitBranch : undefined,
        focused: m.focused === true,
        diagnostics: {
          errors: typeof d.errors === 'number' ? d.errors : 0,
          warnings: typeof d.warnings === 'number' ? d.warnings : 0,
        },
      };
    }
    default:
      return { error: `unknown type ${String(m.type)}` };
  }
}
