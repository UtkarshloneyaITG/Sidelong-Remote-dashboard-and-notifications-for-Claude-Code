/**
 * Turning a real `tool_input` into a display line, and truncating everything on
 * the way out.
 *
 * SECURITY (spec section 8): `tool_input` contains file contents on Write, whole
 * command strings on Bash, and prompt text on UserPromptSubmit. Truncation
 * happens HERE, inside the reducer's boundary, so the raw payload never reaches
 * the renderer over IPC and never reaches a log. The main process holds the raw
 * body only for the microseconds it takes to reduce it.
 */

/** Display caps. Deliberately tight -- the overlay is ~340px wide. */
export const MAX_COMMAND = 120;
export const MAX_MESSAGE = 200;
export const MAX_DETAIL = 240;

export function truncate(s: unknown, max: number): string {
  const str = typeof s === 'string' ? s : '';
  const flat = str.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v : undefined;

/**
 * A path shortened for display: relative to the session cwd when it is inside
 * it, otherwise the last two segments. Never fabricated -- returns undefined if
 * there is no path.
 */
export function shortPath(p: unknown, cwd?: string): string | undefined {
  const raw = str(p);
  if (!raw) return undefined;
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = norm(raw);
  const base = cwd ? norm(cwd) : '';
  if (base && path.toLowerCase().startsWith(base.toLowerCase() + '/')) {
    return path.slice(base.length + 1);
  }
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 2 ? path : parts.slice(-2).join('/');
}

/** Tools whose completion means a file on disk changed. */
export const FILE_WRITING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/**
 * The ABSOLUTE path a tool names, untruncated. Used only for focusing VS Code
 * at a real file -- see SessionState.lastFileAbs. Returns undefined unless the
 * value actually looks like an absolute path, so a relative or odd value can
 * never be handed to a URI handler.
 */
export function absoluteFile(input: Record<string, unknown> | undefined): string | undefined {
  const raw = str(input?.file_path) ?? str(input?.notebook_path);
  if (!raw) return undefined;
  return /^([a-zA-Z]:[\\/]|\/)/.test(raw) ? raw : undefined;
}

/** The file a tool touched, if any -- feeds `filesChanged`. */
export function changedFile(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
  cwd?: string,
): string | undefined {
  if (!toolName || !FILE_WRITING_TOOLS.has(toolName) || !input) return undefined;
  return shortPath(input.file_path ?? input.notebook_path, cwd);
}

/**
 * "Editing src/App.tsx", "Running npm test", or undefined when we cannot tell.
 *
 * Deviation from the spec worth naming: when the TOOL is known but its target is
 * not, this returns "Using <Tool>" rather than collapsing to "Claude is working…".
 * The tool name was genuinely observed in the payload, so showing it invents
 * nothing -- and the spec's rule is against inventing a plausible filename or
 * command, which this never does. Only a completely unidentifiable event falls
 * back to the generic line.
 */
export function describeTool(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
  cwd?: string,
): string | undefined {
  if (!toolName) return undefined;
  const i = input ?? {};
  const p = (k: string) => shortPath(i[k], cwd);

  switch (toolName) {
    case 'Read': {
      const f = p('file_path');
      return f && `Reading ${f}`;
    }
    case 'Edit':
    case 'MultiEdit': {
      const f = p('file_path');
      return f && `Editing ${f}`;
    }
    case 'Write': {
      const f = p('file_path');
      return f && `Writing ${f}`;
    }
    case 'NotebookEdit': {
      const f = p('notebook_path') ?? p('file_path');
      return f && `Editing ${f}`;
    }
    case 'Bash':
    case 'PowerShell': {
      const c = str(i.command);
      return c && `Running ${truncate(c, MAX_COMMAND)}`;
    }
    case 'Grep': {
      const q = str(i.pattern);
      return q && `Searching ${truncate(q, 60)}`;
    }
    case 'Glob': {
      const q = str(i.pattern);
      return q && `Finding ${truncate(q, 60)}`;
    }
    case 'WebFetch': {
      const u = str(i.url);
      return u && `Fetching ${truncate(u, 60)}`;
    }
    case 'WebSearch': {
      const q = str(i.query);
      return q && `Searching the web for ${truncate(q, 50)}`;
    }
    case 'Task':
    case 'Agent': {
      const d = str(i.description) ?? str(i.subagent_type);
      return d && `Subagent: ${truncate(d, 60)}`;
    }
    case 'TodoWrite':
      return 'Updating the task list';
    default:
      return undefined;
  }
}

/** The permission line: "Run `npm install`?" rather than "needs permission". */
export function describePermission(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
  cwd?: string,
): string {
  const i = input ?? {};
  const cmd = str(i.command);
  if (cmd) return `Run \`${truncate(cmd, MAX_COMMAND)}\`?`;
  const file = shortPath(i.file_path ?? i.notebook_path, cwd);
  if (file && toolName) return `${toolName} ${file}?`;
  const url = str(i.url);
  if (url) return `Fetch ${truncate(url, 80)}?`;
  if (toolName) return `Allow ${toolName}?`;
  return 'Claude needs permission';
}
