import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadFixture } from '../../../tools/replay.mjs';
import {
  absoluteFile,
  buildHookConfig, buildView, describePermission, describeTool, findDrift, allowlistProblem,
  PERMISSION_GRACE_MS, humanGap,
  initialState, isStale, mergeHooks, reduce, reduceAll, removeHooks, severityOf, shortPath,
  truncate, parseBridgeMessage, bridgeMatches,
} from '../dist/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures');
const fx = (n) => loadFixture(join(FIXTURES, n));
const run = (n) => reduceAll(initialState, fx(n));
const only = (state) => Object.values(state.sessions)[0];

/** The state sequence a fixture produces, for order-sensitive assertions. */
function sequence(name) {
  let s = initialState;
  const out = [];
  for (const env of fx(name)) {
    s = reduce(s, env);
    const sess = s.sessions[env.event.session_id];
    out.push({ event: env.event.hook_event_name, status: sess.status, message: sess.message });
  }
  return out;
}

// ---------------------------------------------------------------- tool activity

test('tool-activity fixture produces the expected state sequence', () => {
  assert.deepEqual(
    sequence('tool-activity.jsonl').map((s) => `${s.event}:${s.status}`),
    [
      'UserPromptSubmit:WORKING',
      'PreToolUse:WORKING',
      'PostToolUse:WORKING',
      'PreToolUse:WORKING',
      'PostToolUse:WORKING',
      'PreToolUse:WORKING',
      // A failed tool call marks the ACTIVITY failed and leaves the session
      // WORKING. Only StopFailure turns the overlay red -- see reducer.ts.
      'PostToolUseFailure:WORKING',
      'PreToolUse:WORKING',
      'PostToolUse:WORKING',
      'Stop:COMPLETED',
    ],
  );
});

test('activity lines come from real tool input, never invented', () => {
  const seq = sequence('tool-activity.jsonl');
  assert.equal(seq[1].message, 'Reading src/app.ts');
  assert.equal(seq[3].message, 'Editing src/app.ts');
  assert.equal(seq[5].message, 'Running npm test');
});

test('files changed are collected from Edit/Write only', () => {
  const s = only(run('tool-activity.jsonl'));
  assert.deepEqual(s.filesChanged, ['src/app.ts', 'src/health.test.ts']);
  assert.equal(s.details, '2 files changed');
});

test('a failed tool call is recorded on the activity item', () => {
  const s = only(run('tool-activity.jsonl'));
  const failed = s.activity.filter((a) => a.status === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].tool, 'Bash');
  assert.match(failed[0].error, /exit code 1/);
});

test('an interrupt is not a failure', () => {
  // Real PostToolUseFailure payloads carry is_interrupt: true when the user
  // pressed Esc. Painting that red reports the user's own action back as an error.
  let s = reduceAll(initialState, fx('tool-activity.jsonl').slice(0, 6));
  s = reduce(s, {
    protocolVersion: 1, matcher: '*', receivedAt: 9_000,
    event: {
      session_id: 's-tool-1', hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash', tool_use_id: 'toolu_01C', is_interrupt: true,
      error: 'Interrupted by user',
    },
  });
  assert.equal(only(s).activity.some((a) => a.status === 'failed'), false);
  assert.equal(only(s).details, 'Interrupted');
  assert.equal(only(s).status, 'WORKING');
});

test('Stop closes anything still spinning', () => {
  const s = only(run('tool-activity.jsonl'));
  assert.equal(s.activity.some((a) => a.status === 'running'), false);
});

test('Stop summary comes from last_assistant_message', () => {
  const s = only(run('tool-activity.jsonl'));
  assert.match(s.message, /^Added a \/health endpoint/);
});

// ------------------------------------------------------------------ permission

test('PermissionRequest raises WAITING_FOR_PERMISSION with the real command', () => {
  const seq = sequence('permission.jsonl');
  assert.equal(seq[2].status, 'WAITING_FOR_PERMISSION');
  const s = reduceAll(initialState, fx('permission.jsonl').slice(0, 3));
  assert.equal(only(s).pendingPermission.detail, 'Run `npm install`?');
  assert.equal(only(s).pendingPermission.source, 'PermissionRequest');
});

test('Notification[permission_prompt] does NOT stack a second alert', () => {
  const envs = fx('permission.jsonl');
  const after = reduceAll(initialState, envs.slice(0, 4)); // includes the Notification
  const p = only(after).pendingPermission;
  assert.equal(p.source, 'PermissionRequest', 'richer source must win');
  assert.equal(p.detail, 'Run `npm install`?', 'must not be overwritten by the generic message');
});

test('Notification[permission_prompt] alone still surfaces something', () => {
  const s = reduce(initialState, {
    protocolVersion: 1,
    matcher: 'permission_prompt',
    receivedAt: 1000,
    event: { session_id: 'x', hook_event_name: 'Notification', message: 'Claude needs permission to use Bash' },
  });
  assert.equal(only(s).status, 'WAITING_FOR_PERMISSION');
  assert.equal(only(s).pendingPermission.source, 'Notification');
});

test('PostToolUse clears the pending permission', () => {
  const s = only(run('permission.jsonl'));
  assert.equal(s.pendingPermission, undefined);
  assert.equal(s.status, 'COMPLETED');
});

test('PermissionDenied clears the prompt and returns to WORKING', () => {
  let s = reduceAll(initialState, fx('permission.jsonl').slice(0, 3));
  assert.equal(only(s).status, 'WAITING_FOR_PERMISSION');
  s = reduce(s, {
    protocolVersion: 1, matcher: '*', receivedAt: 9000,
    event: { session_id: 's-perm-1', hook_event_name: 'PermissionDenied', tool_name: 'Bash' },
  });
  assert.equal(only(s).status, 'WORKING');
  assert.equal(only(s).pendingPermission, undefined);
});

// ------------------------------------------------------------------- lifecycle

test('lifecycle fixture: SessionStart -> WORKING -> ERROR -> DISCONNECTED', () => {
  const seq = sequence('lifecycle.jsonl');
  assert.equal(seq[0].status, 'IDLE');
  assert.equal(seq[1].status, 'WORKING');
  assert.equal(seq.at(-2).status, 'ERROR');
  assert.equal(seq.at(-2).message, 'Rate limited');
  assert.equal(seq.at(-1).status, 'DISCONNECTED');
});

test('a subagent tool call does not hijack the top-level headline', () => {
  const envs = fx('lifecycle.jsonl');
  // index 4 is a Read issued by the Explore subagent
  const before = reduceAll(initialState, envs.slice(0, 4));
  const after = reduceAll(initialState, envs.slice(0, 5));
  assert.equal(only(before).message, only(after).message, 'headline must not change');
  const nested = only(after).activity.find((a) => a.agentType === 'Explore');
  assert.ok(nested, 'but the nested call is still recorded');
  assert.equal(nested.label, 'Reading src/deep/nested/thing.ts');
});

test('subagent counter goes up and back down', () => {
  const envs = fx('lifecycle.jsonl');
  assert.equal(only(reduceAll(initialState, envs.slice(0, 4))).subagents, 1);
  assert.equal(only(reduceAll(initialState, envs.slice(0, 6))).subagents, 0);
});

test('compaction is surfaced, then cleared', () => {
  const envs = fx('lifecycle.jsonl');
  assert.equal(only(reduceAll(initialState, envs.slice(0, 7))).compacting, true);
  assert.equal(only(reduceAll(initialState, envs.slice(0, 8))).compacting, false);
});

test('StopFailure carries the real error class from the matcher', () => {
  const s = reduceAll(initialState, fx('lifecycle.jsonl').slice(0, 9));
  assert.equal(only(s).error.kind, 'rate_limit');
  assert.match(only(s).details, /Try again in 4 minutes/);
});

// --------------------------------------------------------------- multi-session

test('concurrent sessions stay separate and keyed by session_id', () => {
  const s = run('multi-session.jsonl');
  assert.deepEqual(Object.keys(s.sessions).sort(), ['s-A', 's-B']);
  assert.equal(s.sessions['s-A'].status, 'WAITING_FOR_PERMISSION');
  assert.equal(s.sessions['s-B'].status, 'WORKING');
  assert.deepEqual(s.sessions['s-B'].filesChanged, ['README.md']);
  assert.deepEqual(s.sessions['s-A'].filesChanged, []);
});

test('a session blocked on permission wins the pill over a more recent one', () => {
  const s = run('multi-session.jsonl');
  const view = buildView(s, {
    now: 1_700_000_010_000, staleMs: 60_000,
    bridge: { status: 'disconnected' }, ingestReady: true,
  });
  // s-B emitted last, but s-A is blocked -- that is the state the app exists for.
  assert.equal(view.active.sessionId, 's-A');
  assert.equal(view.active.status, 'WAITING_FOR_PERMISSION');
  assert.equal(view.otherSessions, 1);
});

// ------------------------------------------------------------ invariants

test('no timer or clock can invent a transition: long silence stays WORKING', () => {
  const s = reduceAll(initialState, fx('tool-activity.jsonl').slice(0, 2));
  assert.equal(only(s).status, 'WORKING');
  const stale = isStale(only(s), only(s).lastActivityAt + 10 * 60_000, 60_000);
  assert.equal(stale, true, 'staleness is a display hint...');
  assert.equal(only(s).status, 'WORKING', '...and never a status change');
});

test('reduce is pure: the input state is not mutated', () => {
  const before = reduceAll(initialState, fx('tool-activity.jsonl').slice(0, 4));
  const snapshot = JSON.stringify(before);
  reduce(before, fx('tool-activity.jsonl')[4]);
  assert.equal(JSON.stringify(before), snapshot);
});

test('an unknown event proves liveness without changing status', () => {
  const before = reduceAll(initialState, fx('tool-activity.jsonl').slice(0, 2));
  const after = reduce(before, {
    protocolVersion: 1, receivedAt: 9_999_999,
    event: { session_id: 's-tool-1', hook_event_name: 'SomeFutureEvent' },
  });
  assert.equal(only(after).status, only(before).status);
  assert.equal(only(after).lastActivityAt, 9_999_999);
});

test('an event with no session_id is ignored rather than crashing', () => {
  const s = reduce(initialState, {
    protocolVersion: 1, receivedAt: 1, event: { hook_event_name: 'Stop' },
  });
  assert.deepEqual(s.sessions, {});
});

test('missing event-specific fields degrade instead of throwing', () => {
  const bare = [
    { hook_event_name: 'PreToolUse' },
    { hook_event_name: 'PostToolUse' },
    { hook_event_name: 'PermissionRequest' },
    { hook_event_name: 'Stop' },
    { hook_event_name: 'StopFailure' },
    { hook_event_name: 'Notification' },
    { hook_event_name: 'SessionEnd' },
  ];
  let s = initialState;
  for (const [i, event] of bare.entries()) {
    s = reduce(s, { protocolVersion: 1, receivedAt: 1000 + i, event: { session_id: 'bare', ...event } });
  }
  assert.equal(only(s).status, 'DISCONNECTED');
});

test('PreToolUse with an unrecognised tool never invents a target', () => {
  const s = reduce(initialState, {
    protocolVersion: 1, matcher: '*', receivedAt: 1,
    event: { session_id: 'z', hook_event_name: 'PreToolUse', tool_name: 'SomeMcpTool', tool_input: { q: 1 } },
  });
  assert.equal(only(s).message, 'Using SomeMcpTool');
});

test('PreToolUse with no tool at all falls back to the generic line', () => {
  const s = reduce(initialState, {
    protocolVersion: 1, matcher: '*', receivedAt: 1,
    event: { session_id: 'z', hook_event_name: 'PreToolUse' },
  });
  assert.equal(only(s).message, 'Claude is working…');
});

test('a new turn clears the previous turn outcome', () => {
  let s = run('tool-activity.jsonl');
  assert.equal(only(s).status, 'COMPLETED');
  s = reduce(s, {
    protocolVersion: 1, receivedAt: 2_000_000_000_000,
    event: { session_id: 's-tool-1', hook_event_name: 'UserPromptSubmit', prompt: 'next' },
  });
  assert.equal(only(s).status, 'WORKING');
  assert.deepEqual(only(s).filesChanged, []);
  assert.deepEqual(only(s).activity, []);
  assert.equal(only(s).elapsedMs, 0);
});

// Regression: [Open VS Code] used to hand the session cwd to vscode://file/.
// When Claude works in a SUBFOLDER that opens a NEW window, which can evict the
// workspace hosting the session and cancel it. Only a real FILE may be used.
test('a real absolute FILE path is tracked for focusing the editor', () => {
  const s = only(run('tool-activity.jsonl'));
  assert.equal(s.lastFileAbs, 'D:\\demo\\src\\health.test.ts');
  assert.notEqual(s.lastFileAbs, s.workspace, 'must never be the cwd');
});

test('a session that touched no file exposes no path at all', () => {
  // Bash-only session: nothing safe to open, so the button must degrade rather
  // than fall back to the working directory.
  const s = reduceAll(initialState, fx('permission.jsonl').slice(0, 3));
  assert.equal(only(s).lastFileAbs, undefined);
  assert.ok(only(s).workspace, 'even though the cwd is known');
});

test('absoluteFile rejects anything that is not an absolute path', () => {
  assert.equal(absoluteFile({ file_path: 'src/rel.ts' }), undefined);
  assert.equal(absoluteFile({ file_path: '' }), undefined);
  assert.equal(absoluteFile(undefined), undefined);
  assert.equal(absoluteFile({ file_path: 'D:\\a\\b.ts' }), 'D:\\a\\b.ts');
  assert.equal(absoluteFile({ notebook_path: '/home/x/n.ipynb' }), '/home/x/n.ipynb');
});

test('auto-running sessions are flagged so the bar can drop its buttons', () => {
  const s = run('tool-activity.jsonl');   // permission_mode: acceptEdits
  const opts = { now: 1_700_000_010_000, staleMs: 60_000, bridge: { status: 'disconnected' }, ingestReady: true };
  // Terminal state is not "auto-running"; mid-turn is.
  const mid = reduceAll(initialState, fx('tool-activity.jsonl').slice(0, 2));
  assert.equal(buildView(mid, opts).active.autoRunning, true);
  assert.equal(buildView(s, opts).active.autoRunning, false, 'COMPLETED is not auto-running');

  const asks = reduceAll(initialState, fx('permission.jsonl').slice(0, 2)); // permission_mode: default
  assert.equal(buildView(asks, opts).active.autoRunning, false);
});

// Regression: PermissionRequest fires even when the request is about to be
// auto-approved. Acting on it immediately fired a desktop toast that then sat in
// the Action Center telling you to open VS Code for a command that already ran.
// Regression, observed live: a prompt ended by Esc or by the call failing left
// the session pinned on WAITING_FOR_PERMISSION with no event that would ever
// clear it -- the overlay showed "Claude needs your attention" indefinitely.
test('an interrupted permission prompt does not stick', () => {
  let s = reduceAll(initialState, fx('permission.jsonl').slice(0, 3));
  assert.equal(only(s).status, 'WAITING_FOR_PERMISSION');
  s = reduce(s, {
    protocolVersion: 1, matcher: '*', receivedAt: 9_000,
    event: {
      session_id: 's-perm-1', hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash', is_interrupt: true, error: 'Interrupted by user',
    },
  });
  assert.equal(only(s).status, 'WORKING');
  assert.equal(only(s).pendingPermission, undefined);
});

test('a failed permission prompt does not stick either', () => {
  let s = reduceAll(initialState, fx('permission.jsonl').slice(0, 3));
  s = reduce(s, {
    protocolVersion: 1, matcher: '*', receivedAt: 9_000,
    event: {
      session_id: 's-perm-1', hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash', error: 'Command failed with exit code 1',
    },
  });
  assert.equal(only(s).status, 'WORKING');
  assert.equal(only(s).pendingPermission, undefined);
  assert.equal(only(s).activity.some((x) => x.status === 'failed'), true, 'still reported as failed');
});

test('a tool failure with no permission outstanding leaves status alone', () => {
  const s = only(run('tool-activity.jsonl'));
  // tool-activity has a PostToolUseFailure mid-turn and must stay WORKING there.
  const mid = only(reduceAll(initialState, fx('tool-activity.jsonl').slice(0, 7)));
  assert.equal(mid.status, 'WORKING');
  assert.equal(s.status, 'COMPLETED');
});

// Observed live: a prompt the user DENIED stayed on screen for 17 minutes. A
// session actually blocked emits nothing, so any later event proves it moved on
// -- even when the event that resolved the prompt is one we never receive.
test('any later session event clears a pending prompt', () => {
  const later = [
    { hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'Explore' },
    { hook_event_name: 'SubagentStop', agent_id: 'a', agent_type: 'Explore' },
    { hook_event_name: 'PreCompact' },
    { hook_event_name: 'PostCompact' },
  ];
  for (const event of later) {
    const blocked = reduceAll(initialState, fx('permission.jsonl').slice(0, 3));
    assert.equal(only(blocked).status, 'WAITING_FOR_PERMISSION');
    const after = reduce(blocked, {
      protocolVersion: 1, matcher: '*', receivedAt: 9_000,
      event: { session_id: 's-perm-1', ...event },
    });
    assert.equal(only(after).pendingPermission, undefined, `${event.hook_event_name} must clear it`);
    assert.equal(only(after).status, 'WORKING', `${event.hook_event_name} must unblock`);
  }
});

test('an unknown future event does NOT clear a real prompt', () => {
  // The expensive direction of this error is hiding a genuine prompt, so an
  // event we do not model is left alone rather than assumed to be progress.
  const blocked = reduceAll(initialState, fx('permission.jsonl').slice(0, 3));
  const after = reduce(blocked, {
    protocolVersion: 1, receivedAt: 9_000,
    event: { session_id: 's-perm-1', hook_event_name: 'SomeFutureEvent' },
  });
  assert.equal(after.sessions['s-perm-1'].status, 'WAITING_FOR_PERMISSION');
  assert.ok(after.sessions['s-perm-1'].pendingPermission);
});

test('clearing is a no-op for a session that was never blocked', () => {
  const working = reduceAll(initialState, fx('tool-activity.jsonl').slice(0, 2));
  const after = reduce(working, {
    protocolVersion: 1, matcher: '*', receivedAt: 9_000,
    event: { session_id: 's-tool-1', hook_event_name: 'SubagentStart', agent_type: 'Explore' },
  });
  assert.equal(only(after).status, 'WORKING');
  assert.equal(only(after).message, 'Reading src/app.ts', 'headline must survive');
});

test('a permission inside its grace window is NOT actionable', () => {
  const s = reduceAll(initialState, fx('permission.jsonl').slice(0, 3));
  const at = only(s).pendingPermission.at;
  const opts = { staleMs: 60_000, bridge: { status: 'disconnected' }, ingestReady: true };

  const early = buildView(s, { ...opts, now: at + 100 }).active;
  assert.equal(early.status, 'WAITING_FOR_PERMISSION', 'the state is still honest');
  assert.equal(early.permissionActionable, false, 'but nothing may act on it yet');

  const late = buildView(s, { ...opts, now: at + PERMISSION_GRACE_MS + 1 }).active;
  assert.equal(late.permissionActionable, true);
});

test('an auto-approved permission never becomes actionable', () => {
  // PermissionRequest then PostToolUse 500ms later: approved without a human,
  // well inside the grace window. It must never have been actionable.
  const envs = fx('permission.jsonl');
  const at = only(reduceAll(initialState, envs.slice(0, 3))).pendingPermission.at;
  const opts = { staleMs: 60_000, bridge: { status: 'disconnected' }, ingestReady: true };
  for (let t = at; t < at + PERMISSION_GRACE_MS; t += 100) {
    const v = buildView(reduceAll(initialState, envs.slice(0, 3)), { ...opts, now: t });
    assert.equal(v.active.permissionActionable, false, `actionable at +${t - at}ms`);
  }
  // ...and by the time the grace period would elapse, PostToolUse has cleared it.
  const resolved = reduceAll(initialState, envs.slice(0, 5));
  assert.equal(only(resolved).pendingPermission, undefined);
  assert.equal(buildView(resolved, { ...opts, now: at + 5_000 }).active.permissionActionable, false);
});

test('the grace period stays under the one-second bar the spec sets', () => {
  assert.ok(PERMISSION_GRACE_MS < 1000, `${PERMISSION_GRACE_MS}ms must be under 1s`);
});

test('acknowledging a permission is presentation only, never approval', () => {
  const s = reduceAll(initialState, fx('permission.jsonl').slice(0, 3));
  const key = only(s).pendingPermission && `${only(s).pendingPermission.tool}:${only(s).pendingPermission.at}`;
  const opts = { now: 1_700_000_010_000, staleMs: 60_000, bridge: { status: 'disconnected' }, ingestReady: true };

  const seen = buildView(s, { ...opts, acknowledged: { 's-perm-1': key } }).active;
  assert.equal(seen.permissionAcknowledged, true);
  assert.equal(seen.permissionActionable, false, 'stops shouting');
  // The status and the prompt itself are untouched: acknowledging is not approving.
  assert.equal(seen.status, 'WAITING_FOR_PERMISSION');
  assert.equal(seen.pendingPermission.detail, 'Run `npm install`?');

  const unseen = buildView(s, opts).active;
  assert.equal(unseen.permissionAcknowledged, false);
  assert.equal(unseen.permissionActionable, true);
});

// The bar must say what Claude is DOING, not "Claude needs your attention" --
// which is a state label carrying no information, and was all you got once a
// prompt was acknowledged or still inside its grace window.
test('the headline always reports real work, never a bare status label', () => {
  const opts = { staleMs: 60_000, bridge: { status: 'disconnected' }, ingestReady: true };
  const at = (state, now) => buildView(state, { ...opts, now }).active;

  // running a tool -> the tool
  const reading = reduceAll(initialState, fx('tool-activity.jsonl').slice(0, 2));
  assert.equal(at(reading, 1_700_000_100_000).headline, 'Reading src/app.ts');
  assert.equal(at(reading, 1_700_000_100_000).headlineIsCommand, true);

  // blocked -> the actual command, even before it is actionable
  const blocked = reduceAll(initialState, fx('permission.jsonl').slice(0, 3));
  const pAt = only(blocked).pendingPermission.at;
  assert.equal(at(blocked, pAt + 10).headline, 'Run `npm install`?');
  assert.equal(at(blocked, pAt + 10).permissionActionable, false, 'still inside grace...');
  assert.equal(at(blocked, pAt + 10).headline, 'Run `npm install`?', '...but still informative');

  // acknowledged -> STILL the command, not the generic line
  const seen = buildView(blocked, {
    ...opts, now: pAt + 5_000,
    acknowledged: { 's-perm-1': `${only(blocked).pendingPermission.tool}:${pAt}` },
  }).active;
  assert.equal(seen.headline, 'Run `npm install`?');
  assert.notEqual(seen.headline, 'Claude needs your attention');

  // turn open, nothing running -> Thinking. Uses a `now` INSIDE the stale window;
  // past it the headline deliberately switches to "No events for …" (see below).
  const thinking = reduceAll(initialState, fx('tool-activity.jsonl').slice(0, 3));
  const soon = only(thinking).lastActivityAt + 20_000;
  assert.equal(thinking.sessions['s-tool-1'].activity.some((x) => x.status === 'running'), false);
  assert.equal(at(thinking, soon).headline, 'Thinking…');
  assert.equal(at(thinking, soon).headlineIsCommand, false);

  // finished -> the summary, not "Thinking"
  const done = run('tool-activity.jsonl');
  assert.match(at(done, 1_700_000_100_000).headline, /^Added a \/health endpoint/);
});

// Measured, not assumed: interrupting Claude Code fires NOTHING. Across 168
// captured events, 3 of 6 turns ended with no event at all, and one tool call
// produced a PreToolUse with no PostToolUse or PostToolUseFailure. The bar cannot
// detect an interrupt -- so it must stop asserting that work is still happening.
test('a silent session stops claiming it is still working', () => {
  const opts = { staleMs: 90_000, bridge: { status: 'disconnected' }, ingestReady: true };
  // UserPromptSubmit + PreToolUse + PostToolUse -> turn open, nothing running
  const thinking = reduceAll(initialState, fx('tool-activity.jsonl').slice(0, 3));
  const last = only(thinking).lastActivityAt;

  const fresh = buildView(thinking, { ...opts, now: last + 5_000 }).active;
  assert.equal(fresh.headline, 'Thinking…', 'a short gap is normal');

  const silent = buildView(thinking, { ...opts, now: last + 4 * 60_000 }).active;
  assert.equal(silent.headline, 'No events for 4m');
  assert.equal(silent.status, 'WORKING', 'never invents a terminal state');
  assert.equal(silent.stale, true);
});

test('silence WHILE a tool runs is normal and must not be relabelled', () => {
  // A long build emits nothing between PreToolUse and PostToolUse, so the tool
  // line has to survive. Relabelling it would break every slow command.
  const opts = { staleMs: 90_000, bridge: { status: 'disconnected' }, ingestReady: true };
  const running = reduceAll(initialState, fx('tool-activity.jsonl').slice(0, 6)); // Bash running
  const last = only(running).lastActivityAt;
  const view = buildView(running, { ...opts, now: last + 20 * 60_000 }).active;
  assert.equal(view.headline, 'Running npm test', 'still the real command');
  assert.equal(view.headlineIsCommand, true);
});

test('a pending permission is never relabelled as silence', () => {
  const opts = { staleMs: 90_000, bridge: { status: 'disconnected' }, ingestReady: true };
  const blocked = reduceAll(initialState, fx('permission.jsonl').slice(0, 3));
  const at = only(blocked).pendingPermission.at;
  const view = buildView(blocked, { ...opts, now: at + 30 * 60_000 }).active;
  assert.equal(view.headline, 'Run `npm install`?', 'waiting for a human is not silence');
});

test('humanGap reads as a duration', () => {
  assert.equal(humanGap(4_000), '4s');
  assert.equal(humanGap(95_000), '1m');
  assert.equal(humanGap(3 * 60_000), '3m');
  assert.equal(humanGap(64 * 60_000), '1h 4m');
});

// The one metric only this tool can compute: how long Claude actually waited on
// you. It has to be trustworthy, so it under-counts rather than over-counts.
test('blocked time is banked when a real prompt resolves', () => {
  // permission.jsonl: PermissionRequest at t0+1000, PostToolUse at t0+2000.
  const s = only(run('permission.jsonl'));
  assert.equal(s.blockedMs, 1000);
});

test('an auto-approved prompt contributes nothing', () => {
  // Resolved inside the grace window -- it never waited on a human.
  let st = reduceAll(initialState, fx('permission.jsonl').slice(0, 3));
  const at = only(st).pendingPermission.at;
  st = reduce(st, {
    protocolVersion: 1, matcher: '*', receivedAt: at + 300,
    event: { session_id: 's-perm-1', hook_event_name: 'PostToolUse', tool_name: 'Bash' },
  });
  assert.equal(only(st).blockedMs, 0, '300ms < grace, so it does not count');
});

test('blocked time accumulates across prompts and survives a new turn', () => {
  let st = reduceAll(initialState, fx('permission.jsonl'));   // banks 1000
  assert.equal(only(st).blockedMs, 1000);
  const t = 2_000_000_000_000;
  st = reduce(st, { protocolVersion: 1, receivedAt: t,
    event: { session_id: 's-perm-1', hook_event_name: 'UserPromptSubmit' } });
  assert.equal(only(st).blockedMs, 1000, 'a new turn must not wipe the tally');
  st = reduce(st, { protocolVersion: 1, matcher: '*', receivedAt: t + 100,
    event: { session_id: 's-perm-1', hook_event_name: 'PermissionRequest',
             tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } } });
  st = reduce(st, { protocolVersion: 1, matcher: '*', receivedAt: t + 5_100,
    event: { session_id: 's-perm-1', hook_event_name: 'PostToolUse', tool_name: 'Bash' } });
  assert.equal(only(st).blockedMs, 6000, '1000 + 5000');
});

test('every path out of a prompt banks the same amount', () => {
  // The total must not depend on HOW the prompt ended, or the metric is noise.
  const enders = [
    { hook_event_name: 'PostToolUse', tool_name: 'Bash' },
    { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'boom' },
    { hook_event_name: 'PermissionDenied', tool_name: 'Bash' },
    { hook_event_name: 'Stop' },
    { hook_event_name: 'SessionEnd' },
    { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'D:\\demo\\a.ts' } },
    { hook_event_name: 'SubagentStart', agent_type: 'Explore' },
    { hook_event_name: 'PreCompact' },
  ];
  for (const event of enders) {
    const blocked = reduceAll(initialState, fx('permission.jsonl').slice(0, 3));
    const at = only(blocked).pendingPermission.at;
    const after = reduce(blocked, {
      protocolVersion: 1, matcher: '*', receivedAt: at + 4000,
      event: { session_id: 's-perm-1', ...event },
    });
    assert.equal(only(after).blockedMs, 4000, `${event.hook_event_name} banked the wrong amount`);
  }
});

test('an unresolved prompt banks nothing — under-counting is the safe direction', () => {
  const blocked = reduceAll(initialState, fx('permission.jsonl').slice(0, 3));
  assert.equal(only(blocked).blockedMs, 0, 'still waiting, nothing banked yet');
});

test('severity is derived from status in exactly one place', () => {
  assert.equal(severityOf('WAITING_FOR_PERMISSION'), 'attention');
  assert.equal(severityOf('ERROR'), 'error');
  assert.equal(severityOf('WORKING'), 'active');
});

// -------------------------------------------------------- truncation / privacy

test('file contents in tool_input never survive into the state', () => {
  const s = run('tool-activity.jsonl');
  const blob = JSON.stringify(s);
  assert.equal(blob.includes('many lines of file content'), false);
  assert.equal(blob.includes("import { describe } from 'node:test'"), false);
});

test('prompt text is not carried into the state', () => {
  const s = run('permission.jsonl');
  assert.equal(JSON.stringify(s).includes('install the deps'), false);
});

test('truncate flattens whitespace and caps length', () => {
  assert.equal(truncate('a\n\n  b', 40), 'a b');
  assert.equal(truncate('x'.repeat(50), 10).length, 10);
  assert.equal(truncate(undefined, 10), '');
});

test('shortPath relativises to cwd, else keeps two segments', () => {
  assert.equal(shortPath('D:\\demo\\src\\a.ts', 'D:\\demo'), 'src/a.ts');
  assert.equal(shortPath('D:\\demo\\src\\a.ts', 'd:/demo'), 'src/a.ts');
  assert.equal(shortPath('C:\\other\\deep\\nest\\a.ts', 'D:\\demo'), 'nest/a.ts');
  assert.equal(shortPath(undefined), undefined);
});

test('a long Bash command is truncated in the permission line', () => {
  const detail = describePermission('Bash', { command: 'echo ' + 'x'.repeat(500) });
  assert.ok(detail.length < 140, `got ${detail.length}`);
  assert.match(detail, /^Run `echo/);
});

test('describeTool returns undefined rather than guessing', () => {
  assert.equal(describeTool('Read', {}), undefined);
  assert.equal(describeTool(undefined, { file_path: 'x' }), undefined);
  assert.equal(describeTool('Bash', { description: 'no command here' }), undefined);
});

// ------------------------------------------------------------- hook config

test('every installed hook carries an explicit short timeout', () => {
  const cfg = buildHookConfig(47821, 'tok');
  const all = Object.values(cfg).flat().flatMap((g) => g.hooks);
  assert.ok(all.length > 20);
  for (const h of all) {
    assert.equal(h.type, 'http');
    assert.ok(h.timeout > 0 && h.timeout <= 5, `timeout ${h.timeout} must be short`);
    assert.equal(h.headers['X-Agent-Watcher-Token'], 'tok');
    assert.match(h.url, /^http:\/\/127\.0\.0\.1:47821\//);
  }
});

test('SessionEnd asks for the smallest timeout: it shares a 1.5s budget', () => {
  const cfg = buildHookConfig(47821, 'tok');
  for (const g of cfg.SessionEnd) assert.equal(g.hooks[0].timeout, 1);
});

test('Notification and StopFailure get one hook per matcher, matcher in the URL', () => {
  const cfg = buildHookConfig(47821, 'tok');
  assert.equal(cfg.Notification.length, 8);
  assert.equal(cfg.StopFailure.length, 10);
  const perm = cfg.Notification.find((g) => g.matcher === 'permission_prompt');
  assert.match(perm.hooks[0].url, /\/Notification\/permission_prompt$/);
});

test('install merges into existing hooks and never clobbers them', () => {
  const existing = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
    },
  };
  const merged = mergeHooks(existing, 47821, 'tok');
  assert.equal(merged.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
  assert.equal(merged.hooks.PreToolUse.length, 2);
  assert.equal(merged.hooks.Stop[0].hooks[0].command, 'notify-send done');
});

test('uninstall removes exactly our entries and nothing else', () => {
  const existing = {
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
    otherSetting: 42,
  };
  const merged = mergeHooks(existing, 47821, 'tok');
  const cleaned = removeHooks(merged, 47821);
  assert.deepEqual(cleaned.hooks, existing.hooks);
  assert.equal(cleaned.otherSetting, 42);
});

test('install is idempotent', () => {
  const once = mergeHooks({}, 47821, 'tok');
  const twice = mergeHooks(once, 47821, 'tok');
  assert.deepEqual(twice, once);
});

test('drift is detected when the token or port changes', () => {
  const installed = mergeHooks({}, 47821, 'tok');
  assert.equal(findDrift(installed, 47821, 'tok'), undefined);
  assert.match(findDrift(installed, 47821, 'different'), /different token/);
  assert.match(findDrift(installed, 47999, 'tok'), /not installed/);
  assert.match(findDrift({}, 47821, 'tok'), /not installed/);
});

test('an allowlist that excludes our URL is reported, not silently tolerated', () => {
  assert.equal(allowlistProblem({}, 47821), undefined);
  assert.equal(allowlistProblem({ allowedHttpHookUrls: [] }, 47821), undefined);
  assert.equal(allowlistProblem({ allowedHttpHookUrls: ['http://127.0.0.1:47821/'] }, 47821), undefined);
  assert.deepEqual(
    allowlistProblem({ allowedHttpHookUrls: ['http://example.com/'] }, 47821),
    { needed: 'http://127.0.0.1:47821/hooks/claude-code' },
  );
});

// ----------------------------------------------------------------- bridge

test('bridge messages are validated and version-checked', () => {
  assert.deepEqual(parseBridgeMessage({ type: 'ping' }), { type: 'ping' });
  assert.match(parseBridgeMessage({ type: 'hello', protocolVersion: 99, token: 't' }).error, /protocol 99/);
  assert.match(parseBridgeMessage({ type: 'hello', protocolVersion: 1 }).error, /missing token/);
  assert.match(parseBridgeMessage('nope').error, /not an object/);
  assert.match(parseBridgeMessage({ type: 'wat' }).error, /unknown type/);
});

test('a session is matched to a VS Code window by cwd, across path separators', () => {
  const bridge = { status: 'connected', workspaceFolders: ['D:\\demo'] };
  assert.equal(bridgeMatches('D:\\demo', bridge), true);
  assert.equal(bridgeMatches('d:/demo/src', bridge), true);
  assert.equal(bridgeMatches('D:\\other', bridge), false);
  assert.equal(bridgeMatches('D:\\demo2', bridge), false, 'prefix must respect the separator');
  assert.equal(bridgeMatches(undefined, bridge), false);
  assert.equal(bridgeMatches('D:\\demo', { status: 'disconnected' }), false);
});

test('the view exposes only a matched bridge to a session', () => {
  const s = run('multi-session.jsonl');
  const view = buildView(s, {
    now: 1_700_000_010_000, staleMs: 60_000, ingestReady: true,
    bridge: { status: 'connected', workspaceFolders: ['D:\\projectB'], focused: true },
  });
  assert.equal(view.sessions.find((x) => x.sessionId === 's-B').bridge.focused, true);
  assert.equal(view.sessions.find((x) => x.sessionId === 's-A').bridge, undefined);
});

test('elapsed is live while working and frozen once the turn ends', () => {
  const working = reduceAll(initialState, fx('tool-activity.jsonl').slice(0, 2));
  const done = run('tool-activity.jsonl');
  const now = 1_700_000_100_000;
  const opts = { now, staleMs: 60_000, bridge: { status: 'disconnected' }, ingestReady: true };
  assert.equal(buildView(working, opts).active.elapsedMs, now - only(working).turnStartedAt);
  assert.equal(buildView(done, opts).active.elapsedMs, only(done).elapsedMs);
  assert.equal(buildView(done, opts).active.turnStartedAt, undefined);
});
