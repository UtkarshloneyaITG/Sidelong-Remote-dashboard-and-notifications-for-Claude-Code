// Fixture capture server. Zero deps, run with: node tools/capture/capture.mjs
// Writes every received hook payload to fixtures/captured.jsonl for use as test fixtures.
// This is a DEV TOOL, not shipped. It logs raw payloads to disk -- see README security note.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const OUT = resolve(process.argv[2] ?? 'fixtures/captured.jsonl');
const PORT = Number(process.env.PORT ?? 47821);
mkdirSync(dirname(OUT), { recursive: true });

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.writeHead(204).end(); // respond first, always: a slow hook stalls Claude Code
    if (req.method !== 'POST') return;
    try {
      const json = JSON.parse(body);
      appendFileSync(OUT, JSON.stringify(json) + '\n');
      console.log(`${json.hook_event_name}${json.tool_name ? ' ' + json.tool_name : ''}`);
    } catch {
      appendFileSync(OUT, JSON.stringify({ _unparsed: body }) + '\n');
      console.log('unparsed body, len', body.length);
    }
  });
}).listen(PORT, '127.0.0.1', () => console.log(`capturing -> ${OUT} on 127.0.0.1:${PORT}`));
