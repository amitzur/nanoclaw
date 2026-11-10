/**
 * Streamable-HTTP front end. Every request, including the health probe, must
 * carry `Authorization: Bearer <token>`; the OneCLI gateway injects it for the
 * agent groups that were granted access, so the token never enters a container.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { Logger } from './log.js';
import type { MashovClient } from './mashov-client.js';
import { buildServer } from './tools.js';

export const MCP_PATH = '/mashov/mcp';
export const HEALTH_PATH = '/mashov/health';
const MAX_BODY = 1024 * 1024;

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time bearer comparison (hashing first equalizes lengths). */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) return false;
  return timingSafeEqual(digest(m[1]), digest(token));
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export interface HttpDeps {
  bearerToken: string;
  client: MashovClient;
  log: Logger;
  now?: () => Date;
}

export function createHttpServer(deps: HttpDeps, tls?: { cert: Buffer; key: Buffer }): http.Server | https.Server {
  const handler = createHandler(deps);
  return tls ? https.createServer({ cert: tls.cert, key: tls.key }, handler) : http.createServer(handler);
}

export function createHandler({ bearerToken, client, log, now }: HttpDeps): http.RequestListener {
  return async (req, res) => {
    const pathname = (req.url ?? '/').split('?', 1)[0];
    if (!bearerMatches(req.headers.authorization, bearerToken)) {
      log.warn('http', { status: 401, path: pathname === MCP_PATH || pathname === HEALTH_PATH ? pathname : 'other' });
      sendJson(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="mashov-mcp"' });
      return;
    }
    if (pathname === HEALTH_PATH && req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname !== MCP_PATH) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (req.method !== 'POST') {
      // Stateless server: no SSE stream to open (GET) and no session to end (DELETE).
      sendJson(
        res,
        405,
        { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
        { Allow: 'POST' },
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      return;
    }
    const server = buildServer({ client, log, now });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch {
      log.error('http', { status: 500 });
      if (!res.headersSent)
        sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  };
}
