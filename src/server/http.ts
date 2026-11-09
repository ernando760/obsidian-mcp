import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Settings } from '../settings';
import type { Notes } from '../vault/notes';
import { createMcpServer } from '../tools';

const MAX_BODY = 2 * 1024 * 1024;
export class LocalMcpServer {
  private http: Server | undefined;
  private closing = false;
  private readonly active = new Set<McpServer>();
  constructor(private readonly notes: Notes, private readonly settings: Settings, private readonly version: string) {}

  async start(): Promise<void> {
    if (this.http || this.closing) throw new Error('Server already started or stopped');
    const http = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) this.reply(res, 500, 'Internal server error');
        else res.destroy();
      });
    });
    this.http = http;
    http.requestTimeout = 15_000;
    http.headersTimeout = 10_000;
    http.keepAliveTimeout = 1000;
    http.maxHeadersCount = 32;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { this.http = undefined; reject(error); };
      http.once('error', fail);
      http.listen(this.settings.port, '127.0.0.1', () => { http.off('error', fail); resolve(); });
    });
    // Do not log request data, tokens, or note contents.
    http.on('error', () => console.error('[Obsidian MCP] HTTP server error'));
  }

  async stop(): Promise<void> {
    this.closing = true;
    this.notes.stop();
    const http = this.http;
    this.http = undefined;
    if (http) {
      const closed = new Promise<void>(resolve => http.close(() => resolve()));
      http.closeAllConnections();
      await closed;
    }
    await Promise.allSettled([...this.active].map(server => server.close()));
    this.active.clear();
  }

  private reply(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: message }));
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closing) return this.reply(res, 503, 'Server stopping');
    const port = (this.http?.address() as { port: number } | null)?.port;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host ?? '')) {
      return this.reply(res, 403, 'Invalid Host');
    }
    // Native MCP clients send no Origin. Browser callers are not supported in this MVP.
    if (req.headers.origin !== undefined) return this.reply(res, 403, 'Browser origins are forbidden');
    const expected = Buffer.from(`Bearer ${this.settings.token}`);
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="obsidian-mcp"');
      return this.reply(res, 401, 'Unauthorized');
    }
    if (req.url !== '/mcp') return this.reply(res, 404, 'Not found');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return this.reply(res, 405, 'Only POST is supported in stateless mode');
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      return this.reply(res, 415, 'Expected application/json');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    // A wall-clock timeout also covers slow chunked bodies.
    const timeout = setTimeout(() => req.destroy(), 15_000);
    let body: unknown;
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) {
          this.reply(res, 413, 'Request exceeds 2 MiB');
          return;
        }
        chunks.push(chunk as Buffer);
      }
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return this.reply(res, 400, 'Invalid JSON'); }
    } finally { clearTimeout(timeout); }
    if (this.closing) return this.reply(res, 503, 'Server stopping');
    const server = createMcpServer(this.notes, this.version);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    this.active.add(server);
    const close = () => {
      this.active.delete(server);
      void server.close().catch(() => {});
    };
    res.once('close', close);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      close();
      throw error;
    }
  }
}
