import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export interface HttpAdapterOptions {
  port?: number;
  host?: string;
  serverFactory?: () => Server;
}

export class HttpAdapter {
  private serverFactory: () => Server;
  private options: HttpAdapterOptions;
  private httpServer?: http.Server;

  constructor(serverFactory: () => Server, options: HttpAdapterOptions = {}) {
    this.serverFactory = serverFactory;
    this.options = {
      port: options.port ?? 8080,
      host: options.host ?? '0.0.0.0',
    };
  }

  async start(): Promise<void> {
    this.httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', transport: 'http', version: '1.0.0' }));
        return;
      }
      if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/mcp')) {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = this.serverFactory();
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/mcp')) {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });
    this.httpServer.on('error', (err) => {
      console.error(`[hela-runtime] http server error: ${err.message}`);
    });
    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.options.port, this.options.host, () => {
        console.error(`[hela-runtime] http on ${this.options.host}:${this.options.port}`);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    }
  }
}