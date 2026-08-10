# Capability ledger

Every claim this project could make, classified. Verified against **Claude Code
2.1.119** on Windows 11, against the current
[hooks reference](https://code.claude.com/docs/en/hooks), and — where marked
*(payload captured)* — against real hook payloads recorded from live sessions
with `tools/capture`.

A limitation documented here is worth more than a capability faked.

---

## SUPPORTED

| Claim | Mechanism | Failure mode |
|---|---|---|
| **Session lifecycle** (start, end, resume, clear, logout) | `SessionStart` / `SessionEnd` hooks, one entry per matcher so the reason is known from the URL path | If Claude Code exits without running `SessionEnd` (hard kill), the session stays on its last real status until the 10-minute TTL prunes it. It never fabricates a "disconnected". |
| **Tool-level activity with real targets** — `Reading src/app.ts`, `Running npm test` *(payload captured)* | `PreToolUse` / `PostToolUse`, `tool_name` + `tool_input` | An unrecognised tool (MCP, custom) degrades to `Using <ToolName>`; a tool whose input we cannot read degrades to `Claude is working…`. Never a guessed filename. |
| **Permission detection with the real tool and input** *(payload captured)* | `PermissionRequest` (primary), `Notification[permission_prompt]` (backstop), de-duplicated | If neither fires, the overlay shows `WORKING` and simply does not know. It will not infer a permission prompt from silence. |
| **Telling a real prompt from one about to be auto-approved** | The prompt must outlive `PERMISSION_GRACE_MS` (700 ms) before buttons or a toast may appear. `PermissionRequest` fires even for requests that auto-approve; the approval lands milliseconds later. | A genuine prompt is surfaced 700 ms late — inside the one-second bar. A pathologically slow auto-approval (>700 ms) would briefly show buttons, then clear. |
| **Focusing the right VS Code window without disturbing it** | Bridge `activeFile` → the session's last touched file → nothing. A `statSync().isFile()` gate means a **directory can never** reach `vscode://file/`. | Without the bridge and before Claude has touched any file, the button reports that the bridge is needed and does nothing. That is deliberate: opening the `cwd` as a folder launches a new window and can evict the workspace hosting the session. |
| **Completion with a summary line** *(payload captured)* | `Stop`, using `last_assistant_message` | If the field is absent the message falls back to `Done`. |
| **Typed API errors** | `StopFailure`, matcher gives the real class (`rate_limit`, `overloaded`, `billing_error`, …) | An error class we have no label for renders as `Failed: <class>` rather than a generic error. |
| **User interrupt distinguished from tool failure** *(payload captured)* | `PostToolUseFailure.is_interrupt` | — |
| **File-change tracking** | `PostToolUse` on `Edit` / `Write` / `MultiEdit` / `NotebookEdit`, taking `file_path` | A file written by a shell command (`Bash` doing `>`) is invisible. Only tool-level writes are counted. |
| **Workspace correlation across concurrent sessions** *(verified live with 3 simultaneous sessions)* | `session_id` keys everything; `cwd` matches against the bridge's workspace folders | — |
| **Subagent activity kept separate from top-level** *(payload captured)* | `agent_id` / `agent_type` present on subagent events; `SubagentStart` / `SubagentStop` | — |
| **Compaction visible** | `PreCompact` / `PostCompact` — explains an otherwise inexplicable multi-minute silence | — |
| **VS Code focus / active editor / diagnostics / git branch** | VS Code extension over WebSocket | Absent entirely if the extension is not installed. The overlay says so and keeps working. |
| **Notification suppression while VS Code is focused** | `vscode.window.state.focused` pushed from the bridge | Without the bridge, notifications always fire. |
| **Closing the overlay never affects a coding session** *(verified: tool calls ran in 39ms and 67ms with every hook pointed at a dead server)* | Hook connection failure / timeout / non-2xx are all non-blocking by design | — |
| **Approving or denying a permission** *(opt-in, off by default)* | The `PermissionRequest` response is held open and answered with `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"\|"deny"}}}`. Measured live: allow returns `200` with exactly that body; no click lapses to an empty `204` at 15.0s; a superseding prompt releases the first at 2.8s; a client hangup drops the buttons in ~2s. | **Every non-explicit path is an empty `204`**, which Claude Code treats as "no decision" and falls back to prompting normally — the reference is explicit that *"staying silent doesn't approve it."* The real cost is that while a decision is outstanding **VS Code's own prompt does not appear**, so ignoring the overlay delays the normal prompt by up to `decisionWindowMs`. Answered instantly with "no decision" when the bridge reports VS Code already has focus. |
| **Time spent blocked on you** | Accumulated in the reducer per session from prompts that outlived the grace window, banked per local day by the main process. | Prompts auto-approved inside the grace window and prompts you interrupted contribute nothing — it under-counts rather than over-counts. |
| **Per-day tallies behind the Analysis panel** | Counted from events that arrived: `PreToolUse` → tool calls, `Stop` → turns, `SessionStart` → sessions. Prompts are counted through the same `permissionActionable` gate the bar uses, so the number matches what you were actually shown. Kept 30 days in `stats.json`, sent nowhere. | Restarting mid-turn loses nothing already banked, but a tool call in flight when the app is killed is never counted — the tally is of events seen, not of events that happened. |
| **Acting from the notification** | A `button` action on the toast. Supported on Windows; macOS additionally needs a signed app with an `alert` alert-style. | Where the button is unavailable, clicking the toast body still opens the overlay. |

---

## PARTIALLY SUPPORTED

| Claim | What actually works | What does not |
|---|---|---|
| **Distinguishing "waiting for input" from "idle"** | `Notification` matchers `idle_prompt`, `agent_needs_input` and `elicitation_dialog` map to `WAITING_FOR_INPUT` (amber). When the notification follows a `Stop`, the bar keeps **the question Claude actually asked** rather than the notification's own boilerplate — the last assistant message is the useful sentence, the notice is only a label for it. | **These matchers are documented but were not observed firing during capture**, so the mapping is written from the reference, not from a recorded payload. If they never fire in your setup, a session waiting for input looks like a session that finished. <br><br>Even when they do fire they are *late*: a turn that ends by asking you something emits `Stop` like any other, so from `Stop` until the idle notice arrives the session reads **COMPLETED** — white arc, timer stopped. The bar still shows the question text throughout, because that is `last_assistant_message`; what it cannot say during that window is that an answer is expected. No hook distinguishes "finished" from "finished by asking", and the app will not infer one from a question mark. |
| **Test / build results** | A failed `Bash` call is shown as a failed activity item with the real error text. | Nothing knows that `npm test` *is* the test suite, or that exit 0 means green. Inferring "tests passed" from an exit code is a guess, so the overlay does not make it. The completed state reports files changed, not test results. |
| **"Time saved" in the Analysis panel** | The only *derived* number in the app, and the only one that is not a direct tally. Every counted prompt lands in exactly one of two measured groups — answered in the bar (`B`, timed to the click) or settled in VS Code (`V`, timed to the prompt clearing) — and the estimate is `(w̄_V − w̄_B) × n_B`. It is withheld entirely below 3 samples in either group, or if the difference is negative. | **An estimate, and stated as one on screen.** The groups are self-selected rather than assigned, so it is an observational comparison and not a trial: prompts you miss sit long in `V` and push it up, prompts you catch because you were already in the editor push it down, and the net direction is unknown. Separately, since a grant in VS Code fires no hook, `V`'s wait is read from the tool starting — tens of milliseconds late, which inflates the figure in the app's own favour. There is no way to observe the counterfactual, and the app does not pretend otherwise. |
| **Elapsed time** | Accurate from `UserPromptSubmit`, which is when the turn genuinely starts. | A session resumed mid-turn (or first observed at `PreToolUse`) starts its clock at the first event we saw, which under-reports. Marked by starting the clock only from real events, never backdated. |
| **Reading the transcript file** | `transcript_path` is on every payload, so the file is locatable. | **Deliberately unused.** It lags the live conversation and its format is not a stable public contract. `last_assistant_message` on `Stop` is the supported way to get the summary, and that is what this uses. |
| **Multi-session UI** | The data model keys everything by `session_id` from day one; all live sessions appear in the expanded list; a session blocked on permission always wins the collapsed pill. The `+N` badge counts **live** sessions only — a disconnected one stays listed in the card, which has room to say what happened to it, but does not inflate a number whose whole job is "how much else is going on right now". | The collapsed pill can only show one session at a time — the rest are a `+N` badge. |
| **macOS / Linux** | The code is portable: no Win32 APIs, no shelling out, POSIX `chmod 0600` on the token file. | **Untested anywhere but Windows 11.** Always-on-top levels, notification behaviour and the `vscode://` fallback are the likely rough edges. |

---

## NOT POSSIBLE

| Claim | Why |
|---|---|
| **Watching Codex, Gemini, or any agent other than Claude Code** | **Not supported. Tested against Codex: it does not work.** The reason is *transport*, not events — worth stating precisely, because "they have no hooks" would be wrong. Codex CLI has hooks (`SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`, `SubagentStart`, `Stop`…) and so does Gemini CLI, with similar payload fields. But **both run local commands only**, delivering JSON on stdin — Codex's docs state plainly that only `type: "command"` handlers run. Claude Code is currently the only one that can POST a hook event to an HTTP URL, and this app's receiver is HTTP, so nothing from the others arrives. Bridging one is *feasible*: a relay script that reads stdin and POSTs to the receiver, plus a per-agent config installer and payload verification against real captures. That is a genuine piece of work, not a small adapter — the `AgentAdapter` interface has one implementation and is an internal seam, not a plug-in point. |
| **Reading Claude Code's in-memory state** | No API exposes another extension's internals. The VS Code Extension API cannot see inside the Claude Code extension at all. This is the assumption that sinks naive versions of this project. |
| **Reading terminal scrollback** | There is no supported VS Code API to read a terminal's buffer. `Terminal.processId` and shell integration events do not give you the text. |
| **Knowing what Claude is "thinking" between tool calls** | No hook fires during model inference. A long gap between `PostToolUse` and the next `PreToolUse` is genuinely opaque — which is why a long silence dims the overlay but never changes its status. |
| **Raising the VS Code window from the extension** | VS Code exposes no API for an extension to bring its own OS window to the front. `workbench.action.focusActiveEditorGroup` moves focus *within* the window only. Raising is done by the desktop app opening an already-open **file** via `vscode://file/`, which is why a real file path matters. |
| **Knowing the moment a permission is GRANTED** | **Permission grants are silent — no hook fires.** The order is `PreToolUse → PermissionRequest → PostToolUse`, with nothing in between; only *denials* by the auto-mode classifier get an event (`PermissionDenied`). So if you approve in VS Code, the earliest hard evidence is `PostToolUse` when the tool *finishes* — many seconds later for a long install. Mitigated, not solved: clicking `[Open VS Code]`, or the bridge reporting VS Code took focus, stops the bar drawing attention. Neither claims the prompt was approved, and the real state still clears on `PostToolUse`. |
| **Detecting that a turn was INTERRUPTED** | **Nothing fires when you press Esc — measured, not assumed.** Over 168 captured events, 3 of 6 turns ended with no event whatsoever: no `Stop`, no `PostToolUseFailure`, no `Notification`, no `SessionEnd`. One tool call produced a `PreToolUse` with no matching `PostToolUse`, so its activity stays "running" indefinitely. Mitigated, not solved: once a session with **no tool running** has been silent past the stale threshold, the bar stops asserting an activity and shows `No events for 4m` instead. It never claims the turn stopped, because it cannot know that. Silence *while a tool runs* is left alone — a long build legitimately emits nothing between `PreToolUse` and `PostToolUse`. |
| **Detecting a session that was hard-killed** | `SessionEnd` does not fire on `kill -9`. The session simply stops emitting, which is indistinguishable from Claude thinking for a long time. Resolved by a TTL, not by a guess. |
| **Seeing sessions that started before the hooks were installed** | Hooks are read from settings at session start. Existing sessions are not retrofitted; they appear at their next hook-firing event, or after a restart. |

---

## Things the hooks reference says that this project depends on

Re-verify these if you upgrade Claude Code.

1. **`SessionStart` supports `type: "http"`.** In 2.1.119, `WorktreeCreate` is the *only* event restricted to `command` / `mcp_tool`. Earlier builds restricted `SessionStart` and `Setup` too; if you are on such a build you need a command-hook relay for `SessionStart`. Everything else in this app works regardless.
2. **A 2xx with a body is meaningful.** Text is injected into Claude's context; JSON is parsed as a decision. The ingest handler returns `204` with no body, always.
3. **The default HTTP hook timeout is 600 seconds.** Every installed hook carries an explicit short timeout (5s, and 1s for `SessionEnd`, which shares a ~1.5s budget that Claude Code raises to match the longest per-hook timeout).
4. **Hook failure is non-blocking.** Connection failure, timeout and non-2xx all log and continue. This is the property that makes the whole design acceptable, and it is tested.
5. **`allowedHttpHookUrls`, if set at any level, silently gates HTTP hooks.** Detected at install time and reported with the exact URL to add.
