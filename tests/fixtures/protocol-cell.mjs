import path from 'node:path';
import { createInterface } from 'node:readline';

const mode = path.basename(process.argv[1], '.mjs');
const write = (value) => process.stdout.write(`${value}\n`);
const send = (id, result) => write(JSON.stringify({ jsonrpc: '2.0', id, result }));
setInterval(() => {}, 1000);

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'protocol-fixture', version: '1.0.0' } });
  } else if (request.method === 'tools/list') {
    send(request.id, { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] });
  } else if (request.method === 'tools/call') {
    if (mode === 'noisy') {
      write('[fixture] warming up { not json at all');
      send(request.id, { content: [{ type: 'text', text: `cwd:${process.cwd()}` }] });
    } else if (mode === 'malformed') {
      write(JSON.stringify({ id: request.id, payload: 'missing jsonrpc, result and error' }));
    } else if (mode === 'garbled') {
      write(`{"jsonrpc":"2.0","id":${request.id},"result":{"content":[{"type":"te`);
    } else {
      send(request.id, { content: [{ type: 'text', text: 'ok' }] });
    }
  }
});
