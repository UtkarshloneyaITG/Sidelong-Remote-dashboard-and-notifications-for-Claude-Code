#!/usr/bin/env node
/**
 * Fixture replay harness.
 *
 * Two modes, both of which exist to make "beautiful UI driven by nothing"
 * structurally impossible (spec section 10):
 *
 *   node tools/replay.mjs fixtures/permission.jsonl
 *       Offline. Runs the pure reducer over the fixture and prints the resulting
 *       state sequence. This is what the unit tests assert against.
 *
 *   node tools/replay.mjs fixtures/permission.jsonl --post --token <TOKEN>
 *       POSTs each event to the running desktop app exactly as Claude Code
 *       would, so the overlay can be developed and demoed without a fake-data
 *       switch anywhere in the app. The app cannot tell this from a real session
 *       -- which is the point.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Fixture line -> envelope. `receivedAt` is synthetic and deterministic. */
export function loadFixture(path, t0 = 1_700_000_000_000, stepMs = 500) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      const { matcher, event } = JSON.parse(l);
      return { protocolVersion: 1, matcher, event, receivedAt: t0 + i * stepMs };
    });
}

const args = process.argv.slice(2);
// Run as a CLI, or import loadFixture from the tests. Path check beats comparing
// import.meta.url to argv[1], which needs URL-escaping care on Windows.
if ((process.argv[1] ?? '').endsWith('replay.mjs')) {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: replay.mjs <fixture.jsonl> [--post --token T --port 47821 --speed 1]');
    process.exit(1);
  }
  const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? dflt : args[i + 1];
  };
  const envs = loadFixture(file);

  if (args.includes('--post')) {
    const port = Number(flag('port', 47821));
    const token = flag('token', '');
    const speed = Number(flag('speed', 1));
    if (!token) {
      console.error('--post needs --token (find it in the app config, or the Setup panel)');
      process.exit(1);
    }
    for (const env of envs) {
      const e = env.event;
      const path = env.matcher && !['*'].includes(env.matcher)
        ? `/hooks/claude-code/${e.hook_event_name}/${env.matcher}`
        : `/hooks/claude-code/${e.hook_event_name}`;
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Agent-Watcher-Token': token },
        body: JSON.stringify(e),
      }).catch((err) => ({ status: `ERR ${err.message}` }));
      console.log(String(res.status).padEnd(6), e.hook_event_name, e.tool_name ?? '');
      if (speed > 0) await new Promise((r) => setTimeout(r, 700 / speed));
    }
  } else {
    // Offline: needs the built protocol package.
    let protocol;
    try {
      protocol = require('../packages/protocol/dist/index.js');
    } catch {
      console.error('build the protocol package first:  npm run build -w @agent-watcher/protocol');
      process.exit(1);
    }
    let state = protocol.initialState;
    for (const env of envs) {
      state = protocol.reduce(state, env);
      const s = state.sessions[env.event.session_id];
      console.log(
        `${env.event.hook_event_name.padEnd(20)} -> ${s.status.padEnd(24)} ${s.message}`,
      );
    }
    console.log('\nfinal sessions:', Object.keys(state.sessions).join(', '));
  }
}
