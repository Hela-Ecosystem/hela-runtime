import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const mode = path.basename(process.argv[1], '.mjs');
const logFile = path.join(path.dirname(process.argv[1]), 'events.jsonl');
const log = (event) => appendFileSync(logFile, JSON.stringify({ event, pid: process.pid }) + '\n');
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
process.on('SIGTERM', () => log('SIGTERM'));
setInterval(() => {}, 1000);
log('spawn');

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    log('initialize');
    if (mode === 'boot-hang') return;
    if (mode === 'boot-fail') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'fixture boot failure' } }) + '\n');
      return;
    }
    send(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'isolated-fixture', version: '1.0.0' } });
  } else if (request.method === 'tools/list') {
    send(request.id, { tools: ['echo', 'hang', 'hold', 'crash', 'agent_run'].map((name) => ({ name, inputSchema: { type: 'object' } })) });
    if (mode === 'crash-loop') setTimeout(() => process.exit(17), 30);
  } else if (request.method === 'tools/call') {
    const { name, arguments: args } = request.params;
    log(name);
    if (name === 'hang' || name === 'hold' || args?.hang) return;
    if (name === 'crash') process.exit(17);
    send(request.id, { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, name }) }] });
  }
});
