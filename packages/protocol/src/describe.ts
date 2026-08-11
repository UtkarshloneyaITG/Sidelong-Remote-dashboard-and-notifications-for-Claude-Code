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

/**
 * Programs where the SUBCOMMAND is the verb: `npm test` and `npm publish` are
 * not the same request, and collapsing both to "npm" would answer nobody's
 * question about what they keep being asked.
 */
const SUBCOMMANDED = new Set([
  'npm', 'pnpm', 'yarn', 'bun', 'git', 'cargo', 'docker', 'go', 'make',
  'dotnet', 'poetry', 'bundle', 'composer', 'kubectl', 'terraform', 'gh',
]);

/** A bare word. Deliberately excludes spaces, quotes, slashes and `=`. */
const WORD = /^[A-Za-z0-9_.@-]+$/;

/**
 * A plain path, with no quoting or substitution in it.
 *
 * Checked on the RAW first token, before any basename is taken. Splitting on
 * whitespace tears a quoted path in half — `"/opt/my tools/run.sh"` becomes
 * `"/opt/my`, whose basename is the bare word `my`, so a fragment of somebody's
 * directory would have gone into a file kept for 30 days. A leading quote is the
 * signal that the split was wrong, so anything carrying one is refused outright.
 */
const PATHLIKE = /^[A-Za-z0-9_.@:\\/-]+$/;

/** `make.exe` and `make` are one program. Windows should not fork the key. */
const EXE = /\.(exe|cmd|bat|ps1)$/i;

/**
 * A low-cardinality key for "what does Claude keep asking me about".
 *
 * This one is written to DISK and kept for 30 days, which nothing else derived
 * from a tool input is. So it takes the program name and — only for the handful
 * of tools where the subcommand is the verb — one subcommand, and both must be
 * a bare word. A flag, a path, a URL, a quoted string, an inline environment
 * variable or anything else that could carry a secret fails that test and the
 * key degrades to the tool name, which carries nothing at all.
 *
 * It reads the rendered permission line rather than the raw input because that
 * is what the state keeps. Living next to `describePermission` is the point:
 * the format it parses is the format written six lines below it.
 */
export function commandKey(toolName: string | undefined, detail: string): string {
  const fallback = toolName || 'unknown';
  const run = /^Run `(.+?)`\?$/.exec(detail);
  if (!run) return fallback;

  const tokens = run[1].trim().split(/\s+/);
  const raw = tokens[0] ?? '';
  if (!PATHLIKE.test(raw)) return fallback;
  // Strip any directory part: `/usr/local/bin/npm` and `npm` are one thing, and
  // the path itself is not something to keep.
  const prog = (raw.split(/[\\/]/).pop() ?? '').replace(EXE, '');
  if (!WORD.test(prog)) return fallback;

  const sub = tokens[1];
  if (SUBCOMMANDED.has(prog) && sub && WORD.test(sub)) return `${prog} ${sub}`;
  return prog;
}

/**
 * Tools whose prompt cannot be answered with Allow / Deny.
 *
 * `AskUserQuestion` puts a multiple-choice question in front of you. Approving
 * the tool call does not answer it -- it only lets the question be asked, and you
 * still have to go to the editor and pick an option. So offering Allow/Deny is
 * worse than useless twice over: it implies you have dealt with something you
 * have not, and while the request is held open Claude Code cannot show you the
 * question at all. A held prompt blocks the tool call, and here the tool call IS
 * the question.
 *
 * These get "no decision" immediately, which is what makes the real prompt appear
 * straight away, and the bar shows [Open VS Code] [ok] instead -- because going
 * there is genuinely the only thing you can do.
 */
const ANSWERED_IN_EDITOR = new Set(['AskUserQuestion']);

export const needsEditorAnswer = (toolName: string | undefined): boolean =>
  Boolean(toolName && ANSWERED_IN_EDITOR.has(toolName));

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
