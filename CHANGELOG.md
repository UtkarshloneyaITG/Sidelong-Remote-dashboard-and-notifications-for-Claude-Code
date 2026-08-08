# Changelog

All notable changes to Sidelong. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Anything listed under **Fixed** was found by using the thing, not by reading the
code — each entry names the root cause rather than the symptom.

---

## [0.1.4] — 2026-08-08

### Fixed

- **The bar kept asserting live work after you interrupted Claude.** Enabling the
  new `debugLog` and capturing 168 real events settled what the hooks reference
  does not document: **interrupting fires nothing at all** — 3 of 6 turns ended
  with no event whatsoever, and one tool call produced a `PreToolUse` with no
  matching `PostToolUse`. An interrupt is therefore undetectable.

  So the bar no longer pretends. Once a session with **no tool running** has been
  silent past the stale threshold, the headline becomes `No events for 4m` rather
  than continuing to claim `Thinking…`. It still never invents a terminal state,
  because it genuinely does not know the turn ended. Silence *while a tool is
  running* is deliberately untouched — a long build emits nothing between
  `PreToolUse` and `PostToolUse`, and relabelling that would break every slow
  command.

---

## [0.1.3] — 2026-08-08

### Added

- **Tray icon.** The overlay sets `skipTaskbar` and has no title bar, so there was
  previously no way to tell it was running, and no way to get it back after hiding
  it except remembering the global shortcut. The tray tooltip and first menu entry
  carry live status; the menu has Show, Expand/Minimize, hook status and Quit.
- **Start with Windows** toggle in the tray menu, backed by
  `app.setLoginItemSettings`. Disabled in development builds, where it would
  register the bare `electron.exe` and start nothing useful.
- **Installer shortcuts.** Desktop and Start-menu entries, per-user, no admin.
  Pinning to the taskbar is deliberately not attempted — Windows removed that API
  so installers cannot hijack it, so it stays a manual right-click.
- **`debugLog` config flag**, which had been declared since the first release but
  never implemented. Appends the event *name*, matcher, tool and a truncated
  session id to `debug.log` — and deliberately **no payload**, because
  `tool_input` carries whole file contents, full command strings and prompt text,
  and a debug switch is exactly the one people leave on by accident.
- **Download buttons on the documentation site**, resolved against the newest
  release at load time so they never go stale, with a no-JavaScript fallback to
  the releases page.

### Changed

- The `Co-Authored-By` trailer was removed from every commit message in the
  repository history.
- All URLs updated after the repository rename. GitHub redirects repository URLs
  but **not** GitHub Pages project paths, so the site's canonical, `og:url` and
  sitemap entries had been pointing at a hard 404.

---

## [0.1.2] — 2026-08-08

First release with downloadable binaries.

### Added

- **Windows installer, portable `.exe`, and the VS Code extension `.vsix`**, built
  by GitHub Actions from the tagged commit.
- **Real CI.** Typecheck, the full test suite and a production build on Ubuntu,
  Windows and macOS for every push and pull request, plus `npm audit
  --audit-level=high` as a failing job. The README badges before this were static
  shields.io strings — hardcoded text asserting a result nothing checked.
- **Release workflow** that runs the same checks *before* building, so a tag
  cannot ship a binary that would have failed a pull request.
- **Logo** — an eye glancing sideways, with the pupil pushed far enough left to
  break the eye's edge. An earlier version used the bar's own capsule silhouette
  with an offset dot; it was discarded after rendering at 16–88px showed it read
  unmistakably as an iOS toggle switch.
- **MIT license.**
- **Documentation site** with an installation guide and the capability ledger.

### Fixed

- **`npm test` was broken on Node 20.** `node --test "test/*.test.js"` relies on
  glob expansion inside `--test`, which Node only gained in 21 — while `engines`
  claimed `>=20`. It passed locally on Node 24. CI caught it on its first run.
- **A denied or interrupted permission prompt could stick on the bar forever.** A
  session genuinely blocked emits nothing while it waits, so any later event now
  proves the prompt is no longer blocking. Deliberately not applied to unmodelled
  future events: falsely clearing a real prompt hides the one state this app
  exists for.
- **The overlay leaked the desktop through.** `backdrop-blur` cannot sample what
  is behind a transparent Electron window — it only blurs what is behind it inside
  the page — so a 95%-opaque card showed whatever it sat on top of. Now opaque.

### Changed

- `ws` is bundled rather than externalized, so the app ships with **no runtime
  `node_modules`** and packaging never has to resolve hoisted workspace deps.
- Electron pinned to an exact version; electron-builder downloads a specific
  binary and cannot resolve a range.
- electron-builder 26.x rather than 25.x, whose build-time tree carried a critical
  and eleven high advisories and would have failed our own audit gate.

---

## [0.1.1] — withdrawn

Tagged on a commit carrying the Node 20 test-script bug. The repository's rules
prevent deleting tags, so rather than quietly re-point a published tag it was
superseded by 0.1.2. **No release was published and no binaries were attached.**

---

## [0.1.0] — 2026-08-07

Initial release. Source only — no packaged binary.

### Added

- **Hook-driven status overlay for Claude Code**, built on the supported HTTP hook
  system rather than the VS Code Extension API (which cannot see inside another
  extension), terminal scraping, or screen automation.
- **`packages/protocol`** — a pure `(state, event) → state` reducer with zero
  runtime dependencies, shared by the Electron main process, the renderer and the
  VS Code extension. No I/O, no timers, no `Date.now()`.
- **Hook receiver** that responds `204` before doing any work, because the default
  HTTP hook timeout is 600 seconds and a slow handler stalls the coding session.
- **Hook installer** with exact uninstall, drift detection, `allowedHttpHookUrls`
  detection, and a backup taken before the first modification.
- **VS Code bridge extension** — workspace folders, focus, active file, git branch
  and diagnostics. Entirely optional.
- **Fixture capture and replay tooling.** The app has no fake-data mode; the
  replay harness posts real HTTP hook requests.
- Verified against Claude Code 2.1.119 on Windows 11, including the kill-the-app
  test: tool calls ran in 39 ms and 67 ms with every hook pointed at a dead
  server, confirming the overlay cannot block a coding session.

### Known limitations

See [docs/CAPABILITIES.md](docs/CAPABILITIES.md). The significant ones: permission
*grants* are silent so there is no hook that fires when you approve; nothing fires
during model inference; and macOS and Linux build in CI but their overlay
behaviour is untested.

[0.1.4]: https://github.com/UtkarshloneyaITG/sidelong-claude-code-status-bar/releases/tag/v0.1.4
[0.1.3]: https://github.com/UtkarshloneyaITG/sidelong-claude-code-status-bar/releases/tag/v0.1.3
[0.1.2]: https://github.com/UtkarshloneyaITG/sidelong-claude-code-status-bar/releases/tag/v0.1.2
[0.1.1]: https://github.com/UtkarshloneyaITG/sidelong-claude-code-status-bar/releases/tag/v0.1.1
[0.1.0]: https://github.com/UtkarshloneyaITG/sidelong-claude-code-status-bar/releases/tag/v0.1.0
