/**
 * No-leak guarantee (issue #25): Mashov cookies, CSRF token, login token and
 * password must never reach the agent. These tests look at the raw HTTP
 * response (status line, every header, full body) the container would see,
 * on success and on every upstream failure mode.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createHttpServer, HEALTH_PATH, MCP_PATH } from '../src/http.js';
import { createLogger } from '../src/log.js';
import { MashovClient, type FetchLike } from '../src/mashov-client.js';
import { TOOL_NAMES } from '../src/tools.js';
import { API, CHILDREN, CREDS, fakeMashov, type FakeOptions } from './fake-mashov.js';

const TOKEN = 'leak-bearer-' + 'z'.repeat(40);
const UPSTREAM_SECRET = 'UPSTREAM-SECRET-7f3a';
const SECRETS = [
  CREDS.password,
  CREDS.username,
  TOKEN,
  UPSTREAM_SECRET,
  'sess-',
  'csrf-',
  'MashovSessionID',
  'Csrf-Token',
  ...CHILDREN.map((c) => c.childGuid),
];

type Raw = { status: number; headers: http.IncomingHttpHeaders; body: string };

function rawRequest(url: string, method: string, headers: Record<string, string>, body?: string) {
  return new Promise<Raw>((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function assertClean(r: Raw, label: string, logs: string[]) {
  expect(r.headers['set-cookie'], `${label}: set-cookie`).toBeUndefined();
  const wire = JSON.stringify(r.headers) + '\n' + r.body;
  for (const s of SECRETS) expect(wire, `${label}: response contains ${s}`).not.toContain(s);
  const logText = logs.join('\n');
  for (const s of SECRETS) expect(logText, `${label}: log contains ${s}`).not.toContain(s);
}

/** Upstream response that echoes secrets in body and headers, like a hostile/buggy Mashov. */
const hostile = (status: number, body = `{"message":"${UPSTREAM_SECRET} sess-1 csrf-1"}`) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'set-cookie': `MashovSessionID=sess-evil-${UPSTREAM_SECRET}; Path=/`,
      'x-csrf-token': `csrf-evil-${UPSTREAM_SECRET}`,
      'x-debug': UPSTREAM_SECRET,
    },
  });

let servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});

async function start(fetch: FetchLike) {
  const logs: string[] = [];
  const client = new MashovClient({ ...CREDS, apiBase: API, fetch, now: () => new Date('2026-11-10T10:00:00') });
  const server = createHttpServer({
    bearerToken: TOKEN,
    client,
    log: createLogger((l) => logs.push(l)),
    now: () => new Date('2026-11-10T10:00:00'),
  }) as http.Server;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let id = 0;
  const call = (name: string, args: Record<string, unknown> = {}) =>
    rawRequest(
      base + MCP_PATH,
      'POST',
      {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
    );
  return { base, call, logs };
}

const scenarios: [string, FakeOptions | (() => FetchLike)][] = [
  ['success', {}],
  ['upstream 500 on every resource', { route: () => hostile(500) }],
  ['upstream 502 html', { route: () => hostile(502, `<html>${UPSTREAM_SECRET}</html>`) }],
  ['invalid JSON', { route: () => hostile(200, `not json ${UPSTREAM_SECRET}`) }],
  ['403 forbidden', { route: () => hostile(403) }],
  ['403 changepass', { route: () => hostile(403, `{"message":"change password ${UPSTREAM_SECRET}"}`) }],
  ['404', { route: () => hostile(404) }],
  ['redirect', { route: () => hostile(302) }],
  ['login 401', { loginStatus: 401, loginBody: { message: `${UPSTREAM_SECRET} ${CREDS.password}` } }],
  ['login 500', { loginStatus: 500, loginBody: { message: UPSTREAM_SECRET } }],
  [
    'network error carrying secrets',
    () => async () => {
      throw new Error(`ECONNRESET ${UPSTREAM_SECRET} Cookie: MashovSessionID=sess-1 ${CREDS.password}`);
    },
  ],
  [
    'session expiry and re-login',
    () => {
      let first = true;
      const fake = fakeMashov({
        route: (path) => {
          if (path !== 'login' && first) {
            first = false;
            return hostile(401);
          }
          return undefined;
        },
      });
      return fake.fetch;
    },
  ],
  [
    'secrets embedded in data rows',
    {
      data: {
        homework: [
          {
            lessonDate: '2026-11-09T00:00:00',
            lesson: 1,
            subjectName: 'Math',
            homework: 'x',
            sessionId: UPSTREAM_SECRET,
            cookie: 'MashovSessionID=sess-9',
          },
        ],
      },
    },
  ],
];

describe('no secret reaches the container', () => {
  for (const [label, setup] of scenarios) {
    it(label, async () => {
      const fetch = typeof setup === 'function' ? setup() : fakeMashov(setup).fetch;
      const { call, logs } = await start(fetch);
      for (const name of TOOL_NAMES) {
        const r = await call(name);
        expect(r.status, `${label}/${name}`).toBe(200);
        assertClean(r, `${label}/${name}`, logs);
      }
    });
  }

  it('unknown tool, bad args, bad JSON-RPC, auth failure and health are clean too', async () => {
    const { base, call, logs } = await start(fakeMashov().fetch);
    const rs: [string, Raw][] = [
      ['unknown tool', await call('mashov_nope')],
      ['bad args', await call('mashov_homework', { from: `x${UPSTREAM_SECRET}` })],
      [
        'bad json',
        await rawRequest(base + MCP_PATH, 'POST', { Authorization: `Bearer ${TOKEN}` }, `{${UPSTREAM_SECRET}`),
      ],
      ['no bearer', await rawRequest(base + MCP_PATH, 'POST', {}, '{}')],
      ['health', await rawRequest(base + HEALTH_PATH, 'GET', { Authorization: `Bearer ${TOKEN}` })],
      ['GET mcp', await rawRequest(base + MCP_PATH, 'GET', { Authorization: `Bearer ${TOKEN}` })],
    ];
    for (const [label, r] of rs) {
      expect(r.headers['set-cookie'], label).toBeUndefined();
      const wire = JSON.stringify(r.headers) + '\n' + r.body;
      for (const s of SECRETS.filter((s) => s !== UPSTREAM_SECRET)) expect(wire, `${label}: ${s}`).not.toContain(s);
    }
    for (const s of SECRETS) expect(logs.join('\n')).not.toContain(s);
  });
});
