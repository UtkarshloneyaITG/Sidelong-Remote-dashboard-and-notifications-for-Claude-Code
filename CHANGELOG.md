# Changelog

All notable changes to Sidelong. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Anything listed under **Fixed** was found by using the thing, not by reading the
code — each entry names the root cause rather than the symptom.

---

## [1.1.1] — 2026-08-10

### Fixed

- **The Linux build failed the first time it ever ran**, so v1.1.0 shipped Windows
  binaries only. On Linux, electron-builder derives the executable name from the
  package `name`, and ours is scoped: `@sidelong/desktop` collapses to
  `@sidelongdesktop`, which contains a character it refuses to put in a file path.

  ```
  ⨯ failed to build AppImage
    error=executableName contains characters that cannot be safely used
    in file paths: @sidelongdesktop
  ```

  Windows never hit it because it uses `productName` instead — which is exactly
  why a Windows-only release pipeline could not have caught this. Fixed by setting
  `linux.executableName` explicitly.

- **The window would not have been associated with its launcher entry.** The same
  build warned that `desktopName` was unset, which leaves `app_id` / `WM_CLASS`
  unlinked from the `.desktop` file. That matters more here than for an ordinary
  app: this window is always-on-top, and window-manager rules are exactly how a
  Linux user would tame it. Set `desktopName` and `syncDesktopName`.

---

## [1.1.0] — 2026-08-10

### Added

- **Linux builds: AppImage and `.deb`.** Prompted by a real report — running the
  Windows installer on Ubuntu produces *"an error occurred while loading the
  archive"*, which is Archive Manager being handed an NSIS self-extracting archive
  it half-recognises. The actual problem was that no Linux artifact existed.

  Built by a second release job on `ubuntu-latest`, because electron-builder
  cannot produce either format from a Windows runner. CI has always compiled and
  tested on Ubuntu; only the *release* was Windows-only, which is why nothing
  runnable ever reached the releases page.

  **Not verified running.** Portable code and a green Ubuntu CI job prove it
  compiles, not that always-on-top, the tray icon or notifications behave on a
  given desktop environment. Published so that can be found out.

- **A settings panel**, replacing the hooks-only dialog. Hooks moved into it as one
  section; the rest was previously a JSON file you edited by hand and restarted.

  | Section | Controls |
  |---|---|
  | Hooks | install / remove per scope, live status, drift, real paths |
  | Permission decisions | Allow/Deny on-off, decision window |
  | Behaviour | desktop notifications, start with Windows, stale threshold, auto-collapse |
  | Data | debug log, open data folder, clear statistics |
  | About | version, listening address, shortcut |

  The panel owns the **consequences** of a change rather than leaving them to
  drift detection. Turning decisions on or moving the window **rewrites the
  installed hooks in place**, because the timeout is baked into them and would
  otherwise go stale the moment you touched the setting. Changing the port says
  plainly that it needs a restart instead of appearing to have worked, measured
  against the port actually bound rather than the one in the file.

  Two settings stay file-only and the panel says why: `port` (a listening socket
  cannot move, and every hook points at it) and `shortcut` (capturing a chord
  safely is its own job).

- **Desktop notifications can be turned off.** On by default — a permission prompt
  nobody sees is the problem this app exists for — but off is now one click, and
  it leaves the bar itself working. Gated at the call site rather than inside the
  notifier, so switching them back on does not fire a backlog of toasts for things
  that happened while they were off.

### Fixed

- **Allow / Deny lingered after you answered in VS Code.** The buttons kept
  counting down for the rest of the decision window — up to fifteen seconds
  offering to decide something already decided.

  There is no hook for "approved"; permission grants are silent, measured, and
  that is the limitation this whole app is built around. But the tool then *runs*,
  `PostToolUse` arrives, and the reducer clears the prompt. That clearing is the
  evidence. Main now settles any held prompt whose session has stopped pending,
  with "no decision" — the right answer to a question nobody is asking any more.

  `res.on('close')` did not already cover it: Claude Code keeps the connection
  open after its own prompt is answered, so nothing fired. Measured against the
  running app with a 15s window: hold open at 3s, released **2.88s** later the
  instant `PostToolUse` landed.

---

## [1.0.0] — 2026-08-10

The version number is a **licence boundary**, not a claim that the code changed
shape. Going from MIT to Prosperity revokes nothing already granted, but it does
change the terms for everything from here on, and that is exactly what a major
version is for: v0.x is MIT, v1.x is not. Anyone who wants the MIT terms takes
v0.1.9, and the number tells them where the line is without reading a word.

What it is **not** claiming: that the untested surfaces got tested, or that
platforms beyond Windows 11 got verified. Both are still written down in
[`docs/CAPABILITIES.md`](docs/CAPABILITIES.md) and the README's testing section,
unchanged, because a version bump is not evidence.

### Changed

- **Licence: MIT → [The Prosperity Public License 3.0.0](LICENSE).** Free forever
  for personal, hobby, academic, nonprofit and government use, and free for
  contributing changes back. Commercial use gets a thirty-day trial, one per
  company, after which it needs a commercial licence.

  The source stays public and auditable — that is the point of it and none of it
  changes. You can still read every line, build it yourself, and check what
  produced the binary you downloaded. What is no longer granted is the right to
  sell it or ship it commercially for free.

  > **Everything up to and including v0.1.9 stays MIT, permanently.** That grant
  > is irrevocable and is not being revoked. The MIT text is kept verbatim at
  > `LICENSE-MIT` so the boundary is unambiguous, and v0.1.9 remains the version
  > to take if you want one you may use commercially at no cost.

  Not open source any more, and worth saying plainly: Prosperity is not
  OSI-approved. Expect some corporate policies to disallow it and expect outside
  contributions to dry up. That is the actual price of the change.

- **Added [`TRADEMARK.md`](TRADEMARK.md).** A code licence governs copying the
  software and grants no right to the *name* — a distinction that is easy to miss
  and is how the Linux kernel, Rust, Firefox and PostgreSQL all operate. The code
  is licensed; "Sidelong" and the logo are not. Fork it and rename it. No mark is
  registered, and the file says so rather than implying otherwise.

---

## [0.1.9] — 2026-08-10

### Documentation

- **The README was overstating its own coverage, and undercounting its own tests.**
  It claimed "61 tests" in three places while the suite had grown past it — the
  failure mode of every hand-maintained number, so the count is gone and the CI
  badge is the live one. Added, in the same section, what is **not** covered: the
  HTTP receiver, main process, renderer, notifier, bridge and VS Code extension,
  roughly 2,800 lines with no automated tests, including the `settle()`-runs-once
  guarantee that a blocked tool call depends on.
- **The latency table is now labelled n=1.** Each figure is a single manual
  measurement on one Windows 11 machine. Laid out as a table because that is
  readable — not because a suite produced it, which is how it read.
- **`sandbox: false` now says why.** It was the one security-relevant setting with
  no reason attached. Turning it on was tried and measured: the window never
  survives and Electron quits on all-windows-closed. Left off deliberately, with the
  compensating controls named and a note to revisit when the preload build is next
  touched.

### Changed

- **One name.** The product was called Sidelong on the outside and `agent-watcher`
  on the inside, and the seam showed: the window was titled *Agent Watcher* in
  alt-tab, the VS Code extension was *Agent Watcher Bridge*, its settings lived
  under `agentWatcher.*`, config and 30 days of statistics sat in
  `%APPDATA%\agent-watcher-desktop`, and the hooks in your `settings.json`
  authenticated with `X-Agent-Watcher-Token`. You installed one product and met
  three names.

  Everything now says **Sidelong**, and identifiers use
  `sidelong-claude-status-bar` — which is also the extension's new name, so the
  words people actually search for sit on the searchable surface instead of in
  the product name.

  Nothing is lost on upgrade, and each transition is handled rather than assumed:

  - **Config and statistics migrate on first launch** — copied, not moved, so the
    old folder survives a downgrade and a failed copy can be retried instead of
    having destroyed the original. The token travels with them, which matters more
    than it looks: lose it and every hook silently starts getting 401s.
  - **The receiver accepts both auth headers.** Hooks already written into your
    `settings.json` keep working untouched. Drift detection is what tells you to
    reinstall them, and it cannot tell you anything if the app looks dead.
  - **The extension reads both config folder names and both settings namespaces.**
    Updating the app and updating the extension are separate downloads; whichever
    you do second would otherwise be looking where the other half is not writing.

  Not covered, and deliberately so: the extension **identifier** changed, so VS
  Code treats it as a new extension. If you installed the old bridge, uninstall
  *Agent Watcher Bridge* by hand or you will have two of them contending for the
  same port.

### Fixed

- **"Time saved" could go down.** Reported from use, and the reporter was right that it
  should not be possible. The figure was computed as
  `(mean elsewhere − mean bar) × answered` and recomputed from scratch on every
  render, so both means moved as new prompts arrived — answer one slow prompt today
  and the total credited to days already past shrank. Time already saved cannot be
  un-saved.

  Each prompt is now credited **once**, when it resolves, against the baseline as it
  stood at that moment, and that credit is never revisited. For a fixed set of days
  the total can only grow. A prompt answered slower than your own VS Code average
  banks zero rather than a negative, which makes this a sum of savings and not a net
  — stated in the panel, since it is the one place the figure is deliberately
  generous.

  The maths moved into the protocol package to get there, so it is now covered by
  tests — including one that appends a run of prompts, several of them slow, and
  asserts the total never falls.

- **No `Host` header check on the receiver.** Binding to `127.0.0.1` stops other
  machines connecting; it does not stop a web page you are visiting from resolving
  its own hostname to `127.0.0.1` and posting from your browser. The token would
  have refused it, but the Host header is what makes an attacker guess the token
  rather than get an attempt per page load. Loopback names only, and only our port —
  verified with a raw socket sending `Host: evil.example.com` and a valid token: 403.

- **Windows toast identity.** `setAppUserModelId` was `com.agentwatcher.overlay`
  while the installer writes Start-menu shortcuts under `dev.sidelong.overlay`.
  Windows matches a toast to a shortcut by exactly that ID, so it was being handed
  one that exists under no name at all — found while auditing the naming, not from
  a symptom.

---

## [0.1.8] — 2026-08-10

### Added

- **The installer says whether it is installing, updating or reinstalling.** Running
  `Setup.exe` over an existing copy previously opened a wizard that said "Install",
  with nothing anywhere to say a version was already there or what would happen to
  it. A first page now reads the installed version and names both:

  | Already installed | The wizard says |
  |---|---|
  | Nothing | *Install Sidelong 0.1.7* |
  | An older version | *Update Sidelong — version 0.1.6 is installed. This will update it to 0.1.7.* |
  | The same version | *Reinstall Sidelong 0.1.7 — …continuing reinstalls the same version over it.* |

  All three verified by building the installer and reading the live wizard's control
  text. Three things had to be got right, each of which failed first:

  - The check is a **registry read, not electron-builder's `${isUpdated}`** — that flag
    means "launched by the auto-updater", which is false in exactly the case that
    matters (you downloaded the exe and double-clicked it).
  - It reads **HKCU then HKLM explicitly, not `SHELL_CONTEXT`**. The welcome page is the
    first page, so it runs before the install-mode page sets that context: the read
    silently found nothing for a per-user install and the page cheerfully offered to
    "Install" over the top of one.
  - It runs on MUI's **`SHOW` callback, not `PRE`**. `PRE` fires before the page's
    controls exist, so `SendMessage` had nothing to write to and the compile-time text
    was drawn regardless.

- **A trend against the previous window** in Analysis: "12m, down 58% vs prev 7d",
  comparing the range against the same range immediately before it. Shown only when
  the whole previous window is inside the retained 30 days and is non-zero, so the
  30-day view never shows one.

- **"Keeps asking about"** in Analysis: prompts grouped by what they were about, most
  asked first — the one statistic here you can act on, since anything you always
  approve belongs in your permission allowlist instead.

  That key is written to disk and kept 30 days, which nothing else derived from a tool
  input is, so it takes only a program name plus one subcommand for tools where the
  subcommand is the verb (`npm test`, `git push`), each of which must be a bare word.
  Writing the test first paid for itself: the first version split on whitespace, which
  tears a quoted path in half — `"/opt/my tools/run.sh"` produced the key `my`, a
  fragment of somebody's directory.

---

## [0.1.7] — 2026-08-10

### Added

- **Analysis panel**, from the expanded card. A **7 / 14 / 30 day** filter, a bar per
  day of how long Claude spent blocked on you, and totals for prompts, tool calls and
  turns. Counted from events that arrived — `PreToolUse`, `Stop`, `SessionStart` — with
  prompts counted through the same `permissionActionable` gate the bar uses, so the number
  matches what you were actually shown. Kept 30 days in `stats.json`, sent nowhere. The
  file's old flat shape is still read, so upgrading loses no banked days.

- **Time saved**, and a method rather than a slogan. There is no way to observe what your
  day would have looked like without the overlay, so the app compares two things it can
  both measure: prompts you answered on the bar (**B**, timed to the click) against prompts
  that were settled in VS Code instead (**V**, timed to the prompt clearing). With
  `Δ = w̄_V − w̄_B`, the estimate is `S = Δ × n_B`.

  It is withheld entirely below 3 samples in either group, and withheld if `Δ ≤ 0` — a
  difference of means from one sample each is noise with a decimal point, and a negative
  result means the bar was not faster, which is worth knowing and not worth dressing up.
  Both of its biases are stated in the panel: the groups are self-selected rather than
  assigned, and since a grant in VS Code fires no hook, **V**'s wait is read from the tool
  starting — tens of ms late, which inflates the figure in the app's own favour.

### Fixed

- **A question Claude asked you was overwritten by the notice that it was asking.** When
  `Notification[agent_needs_input]` followed a `Stop`, the bar replaced *"Should I keep the
  old reducer as a fallback, or delete it?"* with *"Claude is waiting for your input"* —
  swapping the only useful sentence on the bar for a label describing it. The message is
  now carried through from the completed turn. Only from `COMPLETED`, since in any other
  state it belongs to an older turn and stale beats dull.

  What is **not** fixed, and is now written down in the ledger: a turn that ends by asking
  you something emits `Stop` like any other, so until the idle notice arrives the session
  reads as finished. No hook distinguishes "finished" from "finished by asking", and the
  app will not infer one from a question mark.

- **The Analysis chart collapsed as the card got shorter.** In a flex column every child is
  shrinkable, so the panel gave away the one thing it exists to show in order to keep the
  numbers below it on screen — down to a row of dashes, then to nothing. It is a scrolling
  block now.

- **The action row sat stranded in the middle of the card.** Both it and the status footer
  had `mt-auto`, so flex split the free space between them.

### Changed

- **The bar's status light is an arc down the capsule's left rim**, lit by a
  gradient that travels along it, in every state. It replaces the 8px dot in the
  row: a dot has to be found and focused on, which is the wrong ask for an
  overlay whose whole job is to be caught peripherally.

  It is the left *border* of a rounded box, not a strip clipped by one — a strip
  stays a rectangle whatever is clipping it, so it reads as a line with two hard
  ends instead of following the rim. The gradient is a background masked down to
  the border ring, since a border cannot itself hold one.

- **A finished turn is white.** It used to be sky blue beside a working emerald
  — two bright cool dots 8px apart in hue, which is a difference you have to go
  looking for. Nothing else uses white.

- **The status line is a ticker.** The old line leaves upward as the new one
  arrives from below into the same spot. Only one is ever legible: the outgoing
  one is fully transparent before the incoming one starts to appear — verified
  frame by frame, at 50 ms only the old text is visible and at 149 ms only the
  new. Transform and opacity only, so it composites off the main thread, and
  `prefers-reduced-motion` gets a plain cut.

- **`+N` counts live sessions only.** A disconnected session lingers in state
  for its TTL so the expanded card can still explain where it went, but counting
  it told you there were three windows to look at when two had already closed.

### Removed

- **The `⚠` on the capsule.** It reads as *"your code has a problem"*, which is
  neither what it means nor anything to do with the session beside it — it means
  **our** hooks are stale. An icon you must open something else to decode has
  already failed at being an icon. Hook drift now says so in words in the
  expanded card's footer, and the words are a button that opens the Hooks panel.

### Fixed

- **The footer wrapped once drift had something to say.** Sharing one flex row
  pushed "Hooks listening" onto two lines and cut the bridge label to "VS Code
  bri…" — a worse problem than the one being reported. Drift takes its own line.

---

## [0.1.6] — 2026-08-10

### Added

- **Resize grips, per mode.** The capsule takes a width-only grip on **both**
  edges; the expanded card takes a both-axis grip in its bottom-right corner.
  Limits live in the main process (bar 360–1600 wide at a fixed 56 tall; card
  300×240 to 1200×1200) and each mode remembers its own size.

  Drawn in the page rather than by the OS, because a **transparent** frameless
  window gets no resize border — measured: `WS_THICKFRAME` is absent whatever
  `resizable` is set to. Native drag-resize and rounded corners cannot coexist.

### Fixed

- **A grip drag died the moment the pointer left the window.** The listeners sat
  on `window`, and a grip is *on* the edge you drag away from — so the first
  move outside the frame stopped delivering events and the resize silently did
  nothing. Root cause was the missing `setPointerCapture`, not the grip
  geometry.
- **The "fixed" edge crawled across the screen during a drag.** Each move
  re-derived the anchor from live bounds, feeding every frame's rounding into
  the next: measured **29 px** of drift on one diagonal drag. The renderer now
  reads that edge once at pointerdown and sends it, and main applies size and
  position in a single `setBounds` instead of `setContentSize` then
  `setPosition`. Re-measured: the anchored edge holds to **0 px** across left,
  right, outward, inward and clamped drags.

---

## [0.1.5] — 2026-08-08

### Added

- **Permission decisions — real Allow / Deny.** `PermissionRequest` can be held
  open and answered with the documented decision body. **Off by default**: it
  changes what this app is, since a watcher gains the ability to run things.
  Enabling it requires reinstalling the hooks, and drift detection now compares
  timeouts so a stale 5-second hook cannot silently cut every decision short.

  Measured against the running app: any non-permission event still returns `204`
  in **81 ms**; a real Allow returns `200` with exactly the decision payload; no
  click lapses to an empty `204` at **15.0 s**; a superseding prompt releases the
  first hold at **2.8 s**; a client hangup drops the buttons in ~2 s.

  **Silence never approves.** Every non-explicit path — lapse, crash, hangup,
  quit, superseded, feature off — sends an empty `204`, which Claude Code treats
  as "no decision" and falls back to prompting you normally. The reference is
  explicit: *"staying silent doesn't approve it."*

  The unavoidable cost: while a decision is outstanding, **VS Code's own prompt
  does not appear**, so ignoring the overlay delays it by up to
  `decisionWindowMs`. Mitigated by answering instantly with "no decision" when
  the bridge reports VS Code already has focus.

- **Open VS Code as a toast button.** Verified against the Electron docs that
  action buttons are supported on Windows (macOS additionally needs a signed app
  with an `alert` alert-style, where it degrades to the toast body).

- **Time blocked on you, per day.** Accumulated in the reducer from prompts that
  outlived the grace window and banked per local day. Auto-approved and
  interrupted prompts contribute nothing, so it under-counts rather than
  over-counts — a test walks all eight ways a prompt can end and asserts they
  bank the same amount.

### Changed

- **Removed the implication that other agents are supported.** The
  `agent-adapters` package claimed to keep the overlay "agnostic about which
  agent it is watching" and offered a Codex or Gemini adapter as "a new file
  plus one `register()` call". Codex was tested: it does not work. The reason is
  **transport, not events** — Codex CLI and Gemini CLI both have hook systems
  with strikingly similar event names, but both run local commands only and hand
  JSON to a script on stdin. Claude Code is currently the only one that can POST
  a hook event to an HTTP URL, which is what this app receives. Supporting
  another agent is feasible via a relay script, but it is real work, not a new
  file against an interface that has exactly one implementation.
- **The overlay window is no longer user-resizable.** Both modes are fixed sizes
  the layout is designed around, and a manual resize was discarded on the next
  toggle anyway — so the drag handles only ever let you stretch the bar into
  something wrong. Programmatic expand/minimize is unaffected.

### Fixed

- Allow/Deny and `[Open VS Code]`/`[ok]` could render together — four buttons for
  one decision, with the hidden pair still clickable and tab-reachable underneath.
  A live decision now suppresses the acknowledge pair, and deciding also marks the
  prompt acknowledged so it does not reappear the instant Allow is clicked.
- An abandoned hold left the buttons counting down against a request nobody was
  waiting on. Closure is now reported and the hold dropped immediately.
- Allow/Deny mounted and unmounted abruptly while the acknowledge pair faded; both
  now use the identical always-mounted, opacity-only treatment.
- Blocked-time stats were only flushed on `will-quit`, which never fires on a
  force-kill — so the figure vanished exactly when someone exercises the
  kill-the-app property this project advertises. Now flushed on the view tick.

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

[1.1.1]: https://github.com/gamith24/sidelong-claude-code-status-bar/releases/tag/v1.1.1
[1.1.0]: https://github.com/gamith24/sidelong-claude-code-status-bar/releases/tag/v1.1.0
[1.0.0]: https://github.com/gamith24/sidelong-claude-code-status-bar/releases/tag/v1.0.0
[0.1.9]: https://github.com/gamith24/sidelong-claude-code-status-bar/releases/tag/v0.1.9
[0.1.8]: https://github.com/gamith24/sidelong-claude-code-status-bar/releases/tag/v0.1.8
[0.1.7]: https://github.com/gamith24/sidelong-claude-code-status-bar/releases/tag/v0.1.7
[0.1.6]: https://github.com/gamith24/sidelong-claude-code-status-bar/releases/tag/v0.1.6
[0.1.5]: https://github.com/gamith24/sidelong-claude-code-status-bar/releases/tag/v0.1.5
[0.1.4]: https://github.com/gamith24/sidelong-claude-code-status-bar/releases/tag/v0.1.4
[0.1.3]: https://github.com/gamith24/sidelong-claude-code-status-bar/releases/tag/v0.1.3
[0.1.2]: https://github.com/gamith24/sidelong-claude-code-status-bar/releases/tag/v0.1.2
[0.1.1]: https://github.com/gamith24/sidelong-claude-code-status-bar/releases/tag/v0.1.1
[0.1.0]: https://github.com/gamith24/sidelong-claude-code-status-bar/releases/tag/v0.1.0
