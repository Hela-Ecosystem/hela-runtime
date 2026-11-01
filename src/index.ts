#!/usr/bin/env node
import { HelaRuntime } from './daemon.js';
import { HttpAdapter } from './http-adapter.js';

function parseArgs(args: string[]) {
  const opts: { transport: string; port: number; host: string } = { transport: 'stdio', port: 8080, host: '0.0.0.0' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--transport' && args[i + 1]) opts.transport = args[++i];
    else if (a.startsWith('--transport=')) opts.transport = a.split('=')[1];
    else if (a === '--port' && args[i + 1]) opts.port = parseInt(args[++i], 10);
    else if (a.startsWith('--port=')) opts.port = parseInt(a.split('=')[1], 10);
    else if (a === '--host' && args[i + 1]) opts.host = args[++i];
    else if (a.startsWith('--host=')) opts.host = a.split('=')[1];
  }
  if (process.env.HELA_TRANSPORT) opts.transport = process.env.HELA_TRANSPORT;
  if (process.env.HELA_HTTP_PORT) opts.port = parseInt(process.env.HELA_HTTP_PORT, 10);
  if (process.env.HELA_HTTP_HOST) opts.host = process.env.HELA_HTTP_HOST;
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rt = new HelaRuntime();
  const shutdown = async () => {
    console.error('[hela-runtime] shutting down...');
    await rt.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await rt.boot();
    if (opts.transport === 'http') {
      const adapter = new HttpAdapter(() => { const s = rt.createServer(); rt.attachHandlers(s); return s; }, { port: opts.port, host: opts.host });
      await adapter.start();
      console.error(`[hela-runtime] http transport on ${opts.host}:${opts.port}`);
    } else {
      await rt.serveStdio();
    }
  } catch (e) {
    console.error('[hela-runtime] fatal:', e);
    process.exit(1);
  }
}

main();