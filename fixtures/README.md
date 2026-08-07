# Fixture corpus

Each `.jsonl` file is one session scenario. Every line is:

```json
{ "matcher": "<matcher from the hook URL, optional>", "event": { ...raw hook payload... } }
```

`receivedAt` is **not** stored. The replay harness assigns it deterministically
(t0 + 500ms per step), which is what makes `reduce()` produce an identical state
sequence on every run.

## Provenance

| File | Origin |
|---|---|
| `tool-activity.jsonl` | **Captured from a real Claude Code 2.1.119 session** on this machine (`tools/capture`), then edited only to shorten `tool_response` bodies. Field names and structure are verbatim. |
| `permission.jsonl` | **Captured real `PermissionRequest`** — this is the exact shape Claude Code sent, including `permission_suggestions` and the absence of `tool_use_id`. |
| `lifecycle.jsonl` | Mixed. `Stop` and `PostToolUseFailure` shapes are **captured real** (including `stop_hook_active`, `background_tasks`, and `is_interrupt`). `SessionStart.source`, `SessionEnd.reason`, `StopFailure.error` and the `Notification` matchers were **not observed firing** during capture and follow the documented reference instead — flagged here rather than assumed. The reducer treats every one of them as optional. |
| `multi-session.jsonl` | Two interleaved `session_id`s, taken from a genuine two-window capture. Paths rewritten to a neutral project. |

## Re-capturing

```bash
node tools/capture/capture.mjs fixtures/raw.jsonl
# install hooks pointing at 127.0.0.1:47821, run a Claude Code session, then:
node tools/replay.mjs fixtures/raw.jsonl
```

**Do not commit raw captures.** `tool_input` carries whole file contents and full
command strings — see the security section of the top-level README. The files
here were hand-reviewed and trimmed.
