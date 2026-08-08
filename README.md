<div align="center">

<img src="docs/assets/logo.svg" width="92" height="92" alt="Sidelong">

# Sidelong

**Know what Claude Code is doing without switching back to VS Code.**

An always-on-top bar showing the live state of every Claude Code session on your machine —
what it is running, what it changed, when it finished, and above all
when it is silently waiting on a permission prompt.

![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Claude Code](https://img.shields.io/badge/Claude%20Code-hooks-D97757?logo=anthropic&logoColor=white)
[![CI](https://github.com/UtkarshloneyaITG/Sidelong-Remote-dashboard-and-notifications-for-Claude-Code/actions/workflows/ci.yml/badge.svg)](https://github.com/UtkarshloneyaITG/Sidelong-Remote-dashboard-and-notifications-for-Claude-Code/actions/workflows/ci.yml)
[![Release](https://github.com/UtkarshloneyaITG/Sidelong-Remote-dashboard-and-notifications-for-Claude-Code/actions/workflows/release.yml/badge.svg)](https://github.com/UtkarshloneyaITG/Sidelong-Remote-dashboard-and-notifications-for-Claude-Code/actions/workflows/release.yml)
[![License](https://img.shields.io/github/license/UtkarshloneyaITG/Sidelong-Remote-dashboard-and-notifications-for-Claude-Code?color=F5B544)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/UtkarshloneyaITG/Sidelong-Remote-dashboard-and-notifications-for-Claude-Code/total?color=F5B544)](https://github.com/UtkarshloneyaITG/Sidelong-Remote-dashboard-and-notifications-for-Claude-Code/releases)

[Why](#why-this-exists) · [What you get](#what-you-get) · [Architecture](#architecture) · [Quick start](#quick-start) · [Using it](#using-it) · [Capabilities](#capabilities) · [Security](#security)

</div>

---

No API key. No telemetry. No network calls. Nothing leaves `127.0.0.1`.

State comes from **Claude Code's own hook system** — a supported, documented integration
point that POSTs lifecycle events to a local endpoint. Not screen scraping, not terminal
parsing, not polling. Hooks fire identically whether Claude Code runs in a terminal, an IDE
extension, the desktop app, or on the web, so one design covers every surface.

```
running      ( ● demo │ Running npm run build ──────────────────  00:12  ▸ )

thinking     ( ● demo │ Thinking…                                 00:14  ▸ )

permission   ( ● demo │ Run `npm install`? ────── [Open VS Code] [ok]  ▸ )

finished     ( ● demo │ Added a /health endpoint and a test ────  01:47  ▸ )
```

## Why this exists

You give Claude Code a task and switch to Chrome, Figma, Slack, or a terminal. Now you are
blind. Is it still working? Did it finish four minutes ago? Did it crash? Or — the expensive
one — **is it sitting on a permission prompt waiting for a click you don't know it needs?**

A permission prompt produces no sound, no taskbar flash, no notification. It just quietly
stops, and you find out when you happen to look. Multiply that by a dozen times a day.

> [!IMPORTANT]
> **The VS Code Extension API cannot solve this.** It cannot see inside another extension,
> terminal scrollback is not readable through any supported API, and screen scraping breaks
> on every UI change. Hooks are the only supported mechanism — that is why the whole design
> is built on them.

## What you get

| Benefit | What it actually does |
|---------|-----------------------|
| **Never miss a permission prompt** | Bar turns amber with the **real command** — ``Run `npm install`?``, not "needs permission" — plus a notification that does not auto-dismiss. |
| **See what it's doing right now** | `Reading src/app.ts` · `Editing src/api.ts` · `Running npm test` · `Thinking…` — from actual tool input, never guessed. |
| **Know when it's done** | Claude's own summary line, files-changed count, and turn duration. |
| **Real errors, not vague ones** | `Rate limited` · `API overloaded` · `Billing problem` — the true error class, with detail. |
| **Auto-run commands tracked, not nagged** | When Claude runs things without asking, the bar tracks them and shows **no buttons** — nothing for you to decide. |
| **Several projects at once** | Every session tracked separately. A session blocked on permission always wins the bar. |
| **Quiet when you're already looking** | With the bridge extension, notifications are suppressed while VS Code has focus. |
| **Long silences don't lie** | A long build or a thinking model dims the bar — it never flips to "error" or "idle" on a timeout. |
| **Zero risk to your session** | Hook failures are non-blocking by design. Killing the overlay cannot affect Claude Code — measured, not assumed. |

> [!NOTE]
> **What it deliberately does not do.** It never approves or denies anything (`[ok]` means
> *seen it*). It never invents a state — every pixel traces to a received event. It never
> touches your project files.

## Architecture

```
   Claude Code  (terminal · IDE extension · desktop · web)
        │
        │  hooks: HTTP POST  ~40 entries, one per event/matcher
        │  http://127.0.0.1:47821/hooks/claude-code/<Event>[/<matcher>]
        ▼
   ┌────────────────────────────────────────────────────────┐
   │  apps/desktop — Electron main                :47821    │
   │                                                        │
   │   HTTP ingest ──────────────┐                          │
   │   • token check, 204, then process                     │
   │                             ▼                          │
   │                    ClaudeCodeAdapter                   │
   │                             │                          │
   │                             ▼                          │
   │                  reduce(state, event)   ◀── THE PRODUCT│
   │                  pure · no I/O · no timers             │
   │                             │                          │
   │                             ▼                          │
   │                      buildView(...)                    │
   │                        │        │                      │
   │              notifier ◀┘        └─▶ IPC (one-way)      │
   └────────────────────────────────────────┬───────────────┘
        ▲                                   │
        │ WebSocket /bridge                 ▼
        │ (optional enrichment)     ┌──────────────────┐
   ┌────┴──────────────────┐        │  The bar         │
   │ extensions/           │        │  React renderer  │
   │  vscode-bridge        │        │  holds NO state  │
   │ workspace · focus ·   │        └──────────────────┘
   │ active file · git ·   │
   │ diagnostics           │
   └───────────────────────┘
```

> [!IMPORTANT]
> **The state machine is a pure function** — `(state, event) → state` in
> [`packages/protocol/src/reducer.ts`](packages/protocol/src/reducer.ts). No I/O, no timers,
> no `Date.now()`, no Electron imports. That function is the product; everything else is
> plumbing around it. It is what the 61 tests test.

### Components

| # | Component | Path | Port | Stack |
|---|-----------|------|------|-------|
| 1 | **Overlay — main + renderer** | `apps/desktop/` | 47821 | Electron 43 · React 19 · Vite 7 · Tailwind v4 |
| 2 | **Protocol — types + reducer** | `packages/protocol/` | — | TypeScript, **zero runtime deps** |
| 3 | **Agent adapters** | `packages/agent-adapters/` | — | TypeScript |
| 4 | **VS Code bridge** | `extensions/vscode-bridge/` | ws `:47821/bridge` | VS Code API · `ws` |
| 5 | **Tools — capture · replay · installer** | `tools/` | — | Node ESM, zero deps |

`packages/protocol` is dependency-free on purpose: it is imported by the Electron main
process, the renderer, **and** the VS Code extension. One definition of every event and
state, no duplication.

### Event → state mapping

| Hook event | Maps to |
|------------|---------|
| `SessionStart` | `IDLE`, session registered |
| `UserPromptSubmit` | `WORKING`, elapsed clock starts |
| `PreToolUse` | `WORKING` + activity item with the real target |
| `PostToolUse` | activity done; `Edit`/`Write` feed files-changed |
| `PostToolUseFailure` | activity failed (or *interrupted* — `is_interrupt`); resolves a stuck prompt |
| `PermissionRequest` | **`WAITING_FOR_PERMISSION`** with the actual tool input |
| `PermissionDenied` | clears the prompt |
| `Notification[permission_prompt]` | de-duplicated backstop for the above |
| `Notification[idle_prompt \| agent_needs_input]` | `WAITING_FOR_INPUT` |
| `Stop` | `COMPLETED`, summary from `last_assistant_message` |
| `StopFailure` | **`ERROR`** with the real error class from the matcher |
| `SessionEnd` | `DISCONNECTED` |
| `SubagentStart` / `Stop` | nested activity, never masquerading as top-level |
| `PreCompact` / `PostCompact` | explains an otherwise inexplicable silence |

> [!NOTE]
> Matchers for `Notification`, `StopFailure`, `SessionStart` and `SessionEnd` travel in the
> **hook URL** (`…/Notification/permission_prompt`), not the body — *which* matcher fired is
> the information we need and no payload field is documented to carry it. Costs ~40 settings
> entries, removes all guessing.

## Download

| | |
|---|---|
| **[Sidelong-Setup-x.y.z.exe](https://github.com/UtkarshloneyaITG/Sidelong-Remote-dashboard-and-notifications-for-Claude-Code/releases/latest)** | Windows installer. Start-menu entry, per-user, no admin. |
| **[Sidelong-x.y.z-portable.exe](https://github.com/UtkarshloneyaITG/Sidelong-Remote-dashboard-and-notifications-for-Claude-Code/releases/latest)** | Single file, run it from anywhere. Nothing installed. |
| **[agent-watcher-bridge.vsix](https://github.com/UtkarshloneyaITG/Sidelong-Remote-dashboard-and-notifications-for-Claude-Code/releases/latest)** | Optional VS Code extension. |

> [!NOTE]
> The binaries are **unsigned** — a code-signing certificate costs a few hundred
> dollars a year. Windows SmartScreen will show "Windows protected your PC" on first
> run; choose **More info → Run anyway**. Every release is built by the
> [Release workflow](.github/workflows/release.yml) from tagged source on GitHub's
> runners, so you can check exactly what produced the file you downloaded — or build
> it yourself with `npm run dist -w @agent-watcher/desktop`.

After installing, launch it and use the **Hooks** panel inside the app (expand the bar →
**Hooks** → **Install**) — no clone needed. From a clone you can instead run
`node tools/install-hooks.mjs install`.

### Keeping it around

The installer creates **Desktop and Start-menu shortcuts**, and the tray menu has a
**Start with Windows** toggle.

> [!NOTE]
> **An installer cannot pin anything to your taskbar.** Windows removed that API
> deliberately, so no application can pin itself — it has to be your click. Right-click
> the Start-menu or Desktop shortcut → **Pin to taskbar**. The overlay itself sets
> `skipTaskbar`, so it never shows a taskbar button of its own; the **tray icon** is how
> you tell it is running and how you get it back.
>
> Windows 11 hides new tray icons behind the **`^`** chevron. Drag it out to keep it
> visible.

## Quick start (from source)

Prerequisites: **Node 20+**, **Claude Code with HTTP hook support** (verified on `2.1.119` —
check with `claude --version`). No API key. **No `.env` file** — the port and token are
generated on first launch into a local config file.

<table>
<tr><th align="left" width="180">1 · Build & launch</th><td>

```bash
npm install
npm run build
npm start
```

</td></tr>
<tr><th align="left">2 · Install hooks</th><td>

```bash
node tools/install-hooks.mjs install     # all projects (recommended)
node tools/install-hooks.mjs status
```

Or in the app: expand → **Hooks** → **Install**.

</td></tr>
<tr><th align="left">3 · Verify</th><td>

```bash
# inside Claude Code
/hooks

# from a shell
curl -H "X-Agent-Watcher-Token: <token>" http://127.0.0.1:47821/health
# {"ok":true,"protocolVersion":1}
```

</td></tr>
<tr><th align="left">4 · Bridge <i>(optional)</i></th><td>

```bash
npm run package -w agent-watcher-bridge
code --install-extension extensions/vscode-bridge/agent-watcher-bridge.vsix
```

Adds focus-aware notification suppression, auto-acknowledge on switching to VS Code,
a reliable `[Open VS Code]` target, git branch and diagnostics.
**The overlay works fully without it.**

</td></tr>
</table>

> [!WARNING]
> **Launching from a terminal inside VS Code?** VS Code sets `ELECTRON_RUN_AS_NODE=1`, which
> makes the Electron binary behave as plain Node — the app silently fails to open a window.
> Run `Remove-Item Env:\ELECTRON_RUN_AS_NODE` (PowerShell) or `unset ELECTRON_RUN_AS_NODE`
> (bash) first.

> [!NOTE]
> **User scope is the default** (`~/.claude/settings.json`) — one install covers every
> project. Per-project (`--scope project`) means no overlay in whichever repo you forgot.
> The installer merges into existing hooks without clobbering them, is idempotent, backs the
> file up once before its first change, and never writes managed policy settings.

## Using it

### The bar

The resting state, a **fixed size** — it never resizes as commands come and go.

| State | What you see |
|-------|--------------|
| Idle | `● Claude · project` + elapsed |
| Working | `● project │ Reading src/app.ts` + elapsed |
| Thinking | `● project │ Thinking…` — turn open, no tool running |
| Auto-run | the command being run, **no buttons** — nothing to decide |
| Permission | amber border, the real command, `[Open VS Code]` `[ok]` |
| Completed | Claude's summary line |
| Error | red dot, the real error class |

Buttons **fade in over the right edge** of the command rather than taking layout space, so
the window never resizes and nothing jumps. Drag the bar anywhere; position is remembered.
`▸` expands to the activity timeline, files changed, other sessions and the Hooks panel;
`–` minimizes back.

### The two buttons

| Button | What it does |
|--------|--------------|
| **`[Open VS Code]`** | Focuses the window running that session. Opens a **file**, never a folder — see [why that matters](#bugs-found-in-real-use). If there is no safe target it says so rather than guessing. |
| **`[ok]`** | **Acknowledges.** The bar stops drawing attention. **Sends nothing to Claude Code.** Status stays `WAITING_FOR_PERMISSION`, the expanded view still shows the prompt, you still approve in VS Code. |

> [!IMPORTANT]
> **Acknowledging is not approving.** A prompt is also auto-acknowledged when you click
> `[Open VS Code]` or (with the bridge) simply switch to VS Code — because you are clearly
> dealing with it. Claude Code fires **no event when a permission is granted**, so this is
> the only timely signal available; it never claims the prompt was approved.

### Notifications

Fired only on **permission needed**, **waiting for input**, **completed**, **failed**.
Never on individual reads or edits. Suppressed when VS Code already has focus.

| State | Title | Body |
|-------|-------|------|
| Permission | `Permission needed — demo` | ``Run `npm install`?`` |
| Waiting | `Waiting for you — demo` | the message |
| Completed | `Finished — demo` | summary, then `2 files changed · 4m 12s` |
| Failed | `Failed — demo` | `Rate limited`, then the detail |

Permission and failure toasts use `timeoutType: 'never'` so they survive you being away.

### Keyboard & status

Global shortcut, default `Ctrl+Shift+Space`: hidden → show, expanded → minimize, visible → focus.

> [!WARNING]
> This default collides with VS Code's **Trigger Parameter Hints**. A global shortcut wins,
> so VS Code loses that binding while Sidelong runs. Change `shortcut` in the config —
> `Ctrl+Alt+Space` is unbound on a stock setup.

🟢 Hooks listening · 🔴 Receiver down · ⚫ VS Code bridge not connected · **no session** ·
⚠️ hooks missing or drifted. *"Bridge disconnected" and "no agent session" are different
problems with different fixes, so they are shown differently.*

## Configuration

No environment variables, no `.env`. One JSON file, created on first launch:

| OS | Path |
|----|------|
| Windows | `%APPDATA%\agent-watcher-desktop\config.json` |
| macOS | `~/Library/Application Support/agent-watcher-desktop/config.json` |
| Linux | `~/.config/agent-watcher-desktop/config.json` |

| Field | Default | Purpose |
|-------|---------|---------|
| `port` | `47821` | Receiver port. **Baked into installed hooks** — changing it needs a reinstall. |
| `token` | random 64 hex | Shared local secret. Generated once, then stable. |
| `shortcut` | `Control+Shift+Space` | Global show/minimize shortcut. |
| `staleMs` | `90000` | Silence after which a working session dims. **Never changes its status.** |
| `completedDismissMs` | `20000` | How long a completed turn stays expanded. `0` disables. |
| `debugLog` | `false` | Opt-in local debug logging. Off by default — payloads are sensitive. |

> [!IMPORTANT]
> The port and token live in a **settings file**, so both must be stable across launches. A
> per-launch random port would orphan every installed hook — and hook failures are silent by
> design, so the only symptom would be an overlay that never updates. On startup the app
> checks the installed config still matches and tells you if it drifted.

## Capabilities

Full ledger: **[docs/CAPABILITIES.md](docs/CAPABILITIES.md)** — every claim classified
SUPPORTED / PARTIALLY SUPPORTED / NOT POSSIBLE, each with its failure mode.

The headline limits, stated plainly:

| Limit | Why |
|-------|-----|
| **Permission grants are silent** | No hook fires when you approve. The order is `PreToolUse → PermissionRequest → PostToolUse` with nothing between, so the earliest hard evidence is the tool *finishing*. Mitigated by acknowledgement, never faked. |
| **Claude's thinking is opaque** | No hook fires during inference. `Thinking…` is an honest name for "turn open, no tool running" — it is a bounded interval, not a readable one. |
| **Test/build results are not reported** | Inferring "tests passed" from an exit code is a guess, so it isn't made. |
| **`WAITING_FOR_INPUT` is best-effort** | Its `Notification` matchers are documented but were never observed firing during capture. |
| **In-memory state is unreadable** | No API exposes another extension's internals. This is what sinks naive versions of this project. |

## Security

- Binds **`127.0.0.1` only**. Never `0.0.0.0`.
- Every hook POST and WebSocket connection authenticated with the local token, compared in
  **constant time**. Unauthenticated requests get `401`.
- Every inbound message schema-validated; protocol versioned; mismatched clients rejected.
- **No telemetry, no external calls, no API key.** Renderer CSP is `connect-src 'none'`.
- **No code path from a received message to a shell.** The one outward action opens a fixed
  `vscode://file/` URL for a path that must pass an absolute-path check **and**
  `statSync().isFile()`.
- The VS Code extension **never modifies project files**.

> [!CAUTION]
> **Hook payloads are as sensitive as your source code.** `tool_input` carries whole file
> contents on `Write`, full command strings on `Bash`, and your prompt text on
> `UserPromptSubmit`. During development, nine captured events came to ~28,000 tokens
> including an unrelated project's complete source file.
>
> Truncation therefore happens **inside the reducer**, before anything crosses IPC — raw
> payloads never reach the renderer. Two tests assert file contents and prompt text cannot
> be found anywhere in the resulting state. Nothing is logged by default; rejections log a
> *reason*, never a payload. `tools/capture` does write raw payloads and its output paths
> are gitignored.

## Development

```bash
npm run dev          # electron-vite dev, HMR on the renderer
npm test             # the reducer suite — 61 tests
npm run typecheck    # all four workspaces
npm run build        # everything

# Drive the real app from a fixture, exactly as Claude Code would.
# There is no fake-data mode anywhere in the app — this posts real hook requests.
node tools/replay.mjs fixtures/permission.jsonl --post --token <token>

node tools/replay.mjs fixtures/permission.jsonl        # offline: print the state sequence
node tools/capture/capture.mjs fixtures/raw.jsonl      # record your own fixtures
```

## Testing

**The reducer is the product, so the reducer is what is tested** — 61 tests over a corpus of
**real captured hook payloads**, asserting state *sequences*, not just end states.

Pinned down: activity lines come from real tool input and are never invented ·
`PermissionRequest` beats the `Notification` backstop and they never double-alert · a
subagent's tool call never hijacks the headline · a long silence stays `WORKING` · `reduce`
is pure · every event-specific field can be missing without throwing · file contents and
prompt text never survive into state · hooks merge without clobbering, uninstall is exact,
install is idempotent, drift is detected.

> [!IMPORTANT]
> **Every claim here is checked by CI, not asserted.** [`ci.yml`](.github/workflows/ci.yml)
runs typecheck, the full test suite and a production build on **Ubuntu, Windows and macOS**
for every push and pull request, plus `npm audit --audit-level=high` as a job that fails the
run. The badges at the top are live workflow status, not hardcoded numbers — if the suite
breaks, the badge goes red on its own. Releases run the same checks before a binary is
built, so a tag can never ship something that would have failed a PR.

*The macOS and Linux jobs prove it **builds** there. They do not prove the overlay
**behaves** there — always-on-top, notifications and focus detection are still only
verified by hand on Windows 11.*

**The kill-the-app test.** The property that makes this design acceptable is that closing
> the overlay must never affect your coding session. Verified directly: app killed
> mid-session, port confirmed dead (`ECONNREFUSED`), then Claude Code tool calls with 11
> hooks firing at the dead server completed in **39 ms and 67 ms** — normal speed. App
> relaunched and recovered **without restarting VS Code**.

**Why the UI cannot be a fake demo.** The renderer holds no agent state — it renders a view
model pushed from main. The preload exposes **no channel that can set a status**: resize,
focus, quit, acknowledge, and hook install/uninstall are the entire API surface. Every
transition comes from the reducer, from a received event; the 2-second view tick only
recomputes elapsed and staleness.

## Decisions

| Decision | Choice |
|----------|--------|
| **Port** | `47821`, fixed. If taken the app **fails loudly** offering "use `47822` and reinstall hooks" or quit — it never silently rebinds, because the port is baked into every installed hook. |
| **Hook scope** | User-level by default; project-level available. |
| **Multi-session** | Most-recently-active in the bar with a `+N` badge; all listed when expanded. A blocked session always wins. |
| **Platforms** | **Windows 11 tested.** macOS/Linux untested — portable code, no Win32 APIs, POSIX `chmod 0600` on the token. |

**Judgment calls.** A failed tool call marks that *activity* failed and stays `WORKING` —
Claude routinely recovers from a failed grep, and flipping to `ERROR` each time makes red
meaningless; only `StopFailure` sets `ERROR`. `is_interrupt` means *you pressed Esc*, closed
as done rather than painted red. A known tool with an unknown target shows `Using <Tool>`
rather than the generic line — the tool name was genuinely observed. There is **no
`tools/hook-relay/`**: the spec assumed `SessionStart` cannot use HTTP hooks, but on 2.1.119
it can (`WorktreeCreate` is the only restricted event, and this app doesn't use it), so the
relay would be dead code.

## Bugs found in real use

<details>
<summary><b><code>[Open VS Code]</code> could cancel your session</b></summary>

The fallback handed the session's `cwd` to `vscode://file/`. A **directory** opens as a
**new window** — and `cwd` is very often a **subfolder** of the workspace, which VS Code will
not match to your open window. So it replaced that window and killed the session in it.

Fixed at the source: a directory is never passed to the URI handler. The button resolves
bridge `activeFile` → the session's last touched file → nothing, with a
`statSync().isFile()` gate making the folder case structurally impossible. Opening a *file*
reuses and raises the window that already has it. **A dead button beats a destroyed session.**
</details>

<details>
<summary><b>A toast told you to open VS Code for a command that had already run</b></summary>

`PermissionRequest` fires even when the request is about to be auto-approved. The bar cleared
correctly milliseconds later, but the Windows toast had already fired and stayed in the
Action Center.

Fixed by keying on **survival, not on `permission_mode`**: a prompt must outlive
`PERMISSION_GRACE_MS` (700 ms, still inside the one-second bar) before anything may act on
it. `permission_mode` would have been the wrong signal — `acceptEdits` auto-approves edits
but still genuinely prompts for Bash (verified in a captured payload), so suppressing on mode
would hide the one state this app exists for.
</details>

<details>
<summary><b>A prompt could stick forever</b></summary>

If a prompt ended by interrupt (Esc) or by the call failing rather than approval, nothing
cleared it — the session sat on `WAITING_FOR_PERMISSION` indefinitely. `PostToolUseFailure`
now resolves an outstanding prompt for that tool, because the call is over either way.
</details>

<details>
<summary><b>The bar resized itself constantly</b></summary>

It auto-sized to its content, so the window jumped every time a command started or a prompt
appeared — distracting in exactly the peripheral-vision role it has. Now one fixed size, with
buttons fading in *over* the command's right edge instead of taking layout space.
</details>

<details>
<summary><b>"Claude needs your attention" told you nothing</b></summary>

Once a prompt was acknowledged or still inside its grace window, the bar fell back to a bare
status label instead of the work in progress. The headline is now computed in one place and
always prefers the most concrete real thing known: the pending command → the running tool →
`Compacting context…` → `Thinking…` → the status message.
</details>

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| **Overlay never updates** | `node tools/install-hooks.mjs status`. If `allowedHttpHookUrls` is set anywhere it silently gates HTTP hooks — the installer prints the exact URL to add. Sessions already running when you installed hooks are **not** retrofitted; restart them. |
| **No window opens** | `ELECTRON_RUN_AS_NODE=1` is set by VS Code. Unset it. |
| **"Port 47821 is already in use"** | Deliberate — moving silently would orphan every installed hook. Free the port, or accept the dialog's offer to move to `47822` and reinstall. |
| **`[Open VS Code]` says "Install the VS Code bridge"** | No safe file to open yet and no bridge to name the active one. Install the extension. Intentional: the alternative used to kill sessions. |
| **Notifications fire while I'm in VS Code** | Install the bridge extension — focus detection needs it. |
| **Did the overlay break my session?** | It cannot. Hook failures are non-blocking by design, and this is tested. |

## Uninstalling

```bash
node tools/install-hooks.mjs uninstall                 # user scope
node tools/install-hooks.mjs uninstall --scope project
code --uninstall-extension agent-watcher.agent-watcher-bridge
```

Removes **only** entries whose URL starts with this app's base URL — nothing else is touched.
Your original settings file is also backed up at `settings.json.agent-watcher-backup` from
before the first change. Inside Claude Code, `/hooks` shows what remains and
`disableAllHooks` turns everything off at once.

## License

**[MIT](LICENSE) — free for everyone, forever.**

Use it, modify it, redistribute it, build a product on it, sell it. Commercial
use is fine and you owe nothing. The only condition is that the copyright notice
stays in copies of the source — that is the whole of it.

No warranty is given, which is standard for MIT: if it breaks, you keep both
pieces. Worth noting that the one failure mode people actually care about here is
covered by design rather than by a legal disclaimer — hook failures are
non-blocking, so Sidelong cannot take your coding session down with it.

## Roadmap — permission controls

`PermissionRequest` accepts a decision in the response body:

```json
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest",
  "decision": { "behavior": "allow" } } }
```

So real `[Allow]` / `[Deny]` buttons are achievable through a supported mechanism, and the
ingest handler is already shaped so a response body *could* be returned.

> [!CAUTION]
> **Deliberately not implemented.** Returning a decision means holding the HTTP response open
> until you click, which **blocks that tool call** for the whole time — against a 600-second
> default timeout. That behaviour needs to be understood and tested before it is trusted, and
> an overlay that can approve tool calls is a meaningfully larger security surface than one
> that only watches. It deserves its own threat model.
>
> Until then: observe, notify, offer `[Open VS Code]`. **`[ok]` acknowledges only. It never
> simulates approval.**
