import { createInterface } from 'node:readline';

const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
setInterval(() => {}, 1000);

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'url-fixture', version: '1.0.0' } });
  } else if (request.method === 'tools/list') {
    send(request.id, { tools: [{ name: 'runtime_url', inputSchema: { type: 'object' } }] });
  } else if (request.method === 'tools/call') {
    send(request.id, { content: [{ type: 'text', text: process.env.HELA_RUNTIME_URL ?? 'unset' }] });
  }
});
