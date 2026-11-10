import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bearerMatches, createHttpServer, HEALTH_PATH, MCP_PATH } from '../src/http.js';
import { createLogger } from '../src/log.js';
import { MashovClient } from '../src/mashov-client.js';
import { TOOL_NAMES } from '../src/tools.js';
import { API, CHILDREN, CREDS, fakeMashov } from './fake-mashov.js';

const TOKEN = 'test-bearer-' + 'x'.repeat(40);

/**
 * fetch over node:http so the test never goes through an HTTP(S)_PROXY that
 * the environment may set for the global fetch.
 */
function directRequest(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request(url, { method: init.method ?? 'GET', headers: init.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

async function directFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  const r = await directRequest(String(input), {
    method: init?.method,
    headers,
    body: typeof init?.body === 'string' ? init.body : undefined,
  });
  const h = new Headers();
  for (const [k, v] of Object.entries(r.headers)) if (typeof v === 'string') h.set(k, v);
  return new Response(r.body.length ? r.body : null, { status: r.status, headers: h });
}

let server: http.Server;
let base: string;
const logLines: string[] = [];
const fake = fakeMashov();

beforeAll(async () => {
  const client = new MashovClient({
    ...CREDS,
    apiBase: API,
    fetch: fake.fetch,
    now: () => new Date('2026-11-10T10:00:00'),
  });
  server = createHttpServer({
    bearerToken: TOKEN,
    client,
    log: createLogger((l) => logLines.push(l)),
    now: () => new Date('2026-11-10T10:00:00'),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function connect(token = TOKEN) {
  const transport = new StreamableHTTPClientTransport(new URL(base + MCP_PATH), {
    fetch: directFetch,
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const c = new Client({ name: 'test', version: '0.0.0' });
  await c.connect(transport);
  return c;
}

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0].text;
}

describe('bearerMatches', () => {
  it('accepts only the exact token', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    expect(bearerMatches('Bearer ', TOKEN)).toBe(false);
  });
});

describe('auth on every request', () => {
  const init = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
  });
  const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

  it('rejects a missing bearer on MCP, health, and unknown paths', async () => {
    for (const [method, path] of [
      ['POST', MCP_PATH],
      ['GET', HEALTH_PATH],
      ['GET', '/'],
    ] as const) {
      const r = await directRequest(base + path, {
        method,
        headers: mcpHeaders,
        body: method === 'POST' ? init : undefined,
      });
      expect(r.status).toBe(401);
      expect(r.headers['www-authenticate']).toMatch(/^Bearer/);
    }
  });

  it('rejects a wrong bearer', async () => {
    const r = await directRequest(base + MCP_PATH, {
      method: 'POST',
      headers: { ...mcpHeaders, authorization: 'Bearer wrong' },
      body: init,
    });
    expect(r.status).toBe(401);
    await expect(connect('wrong-token')).rejects.toThrow();
  });

  it('serves health and 405s non-POST MCP calls when authorized', async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await directRequest(base + HEALTH_PATH, { headers: auth })).status).toBe(200);
    expect((await directRequest(base + MCP_PATH, { headers: auth })).status).toBe(405);
    expect((await directRequest(base + '/mcp', { headers: auth })).status).toBe(404);
  });
});

describe('MCP tools', () => {
  it('lists exactly the read-only tools', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    await c.close();
  });

  it('mashov_children returns names and classes, never guids or family names', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'mashov_children', arguments: {} });
    const body = JSON.parse(textOf(r));
    expect(body).toEqual({
      year: 2027,
      children: [
        { name: 'Alef', class: 'ג2' },
        { name: 'Bet', class: 'ה1' },
      ],
    });
    expect(textOf(r)).not.toContain('guid-');
    await c.close();
  });

  it('mashov_homework uses default dates and filters by child', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'mashov_homework', arguments: { child: 'bet' } });
    const body = JSON.parse(textOf(r));
    expect(body.from).toBe('2026-11-03');
    expect(body.to).toBe('2026-11-24');
    expect(body.results).toHaveLength(1);
    expect(body.results[0].child).toBe('Bet (ה1)');
    const hwCall = fake.calls.find((x) => x.url.includes('/homework?'))!;
    expect(hwCall.url).toContain('students/guid-bbbb-2222/homework?from=2026-11-03&to=2026-11-24&year=2027');
    await c.close();
  });

  it('reports a bad child name as a tool error', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'mashov_grades', arguments: { child: 'Zayin' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/No child matches/);
    await c.close();
  });

  it('every tool runs against the synthetic API without leaking secrets', async () => {
    const c = await connect();
    const outputs: string[] = [];
    for (const name of TOOL_NAMES) {
      const r = await c.callTool({ name, arguments: {} });
      expect(r.isError, name).toBeFalsy();
      outputs.push(textOf(r));
    }
    const all = outputs.join('\n');
    expect(all).toContain('"unread":3');
    expect(all).not.toContain('MAIL BODY');
    expect(all).not.toContain('Secret subject');
    expect(all).not.toContain('office@school.test');
    for (const secret of [
      CREDS.password,
      CREDS.username,
      TOKEN,
      'csrf-',
      'sess-',
      ...CHILDREN.map((k) => k.childGuid),
      'Testfamily',
    ])
      expect(all, secret).not.toContain(secret);
    await c.close();
  });

  it('logs contain no credentials, tokens, child names or ids', () => {
    const logs = logLines.join('\n');
    expect(logs).toContain('"tool":"mashov_children"');
    for (const secret of [
      CREDS.password,
      CREDS.username,
      TOKEN,
      'csrf-',
      'sess-',
      'Alef',
      'Bet',
      'Testfamily',
      ...CHILDREN.map((k) => k.childGuid),
    ])
      expect(logs, secret).not.toContain(secret);
  });

  it('only GETs reach Mashov after the single login', () => {
    const posts = fake.calls.filter((c) => c.method !== 'GET');
    expect(posts.map((c) => c.url)).toEqual([API + 'login']);
  });
});
