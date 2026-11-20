import { describe, expect, it } from 'vitest';

import {
  MashovAuthError,
  MashovClient,
  MashovPasswordChangeError,
  MashovUnavailableError,
  mashovYear,
} from '../src/mashov-client.js';
import { API, CREDS, fakeMashov } from './fake-mashov.js';

const fixedNow = () => new Date('2026-11-10T10:00:00');

function client(
  fake: ReturnType<typeof fakeMashov>,
  extra: Partial<ConstructorParameters<typeof MashovClient>[0]> = {},
) {
  return new MashovClient({ ...CREDS, apiBase: API, fetch: fake.fetch, now: fixedNow, ...extra });
}

describe('mashovYear', () => {
  it('rolls over on September 1st', () => {
    expect(mashovYear(new Date('2026-08-31T12:00:00'))).toBe(2026);
    expect(mashovYear(new Date('2026-09-01T12:00:00'))).toBe(2027);
  });
});

describe('login', () => {
  it('posts the web-client payload and keeps cookies + CSRF in memory', async () => {
    const fake = fakeMashov();
    const c = client(fake);
    const kids = await c.getChildren();
    expect(kids.map((k) => k.firstName)).toEqual(['Alef', 'Bet']);
    expect(fake.calls[0].method).toBe('POST');
    expect(fake.calls[0].url).toBe(API + 'login');
    const body = JSON.parse(fake.calls[0].body!);
    expect(body).toMatchObject({ semel: 999999, year: 2027, IsBiometric: false, appName: 'info.mashov.students' });
    expect(fake.calls[0].headers.origin).toBe('https://web.mashov.info');

    await c.get('students/guid-aaaa-1111/grades', 'grades');
    const get = fake.calls[1];
    expect(get.method).toBe('GET');
    expect(get.headers['x-csrf-token']).toBe('csrf-1');
    expect(get.headers.cookie).toContain('MashovSessionID=sess-1');
    expect(get.headers.cookie).toContain('Csrf-Token=csrf-1');
  });

  it('logs in lazily, once, even with concurrent callers', async () => {
    const fake = fakeMashov();
    const c = client(fake);
    expect(fake.calls).toHaveLength(0);
    await Promise.all([c.getChildren(), c.get('holidays', 'holidays'), c.get('mail/counts', 'mail')]);
    expect(fake.logins).toBe(1);
  });

  it('401 is an auth error, is not retried, and backs off', async () => {
    const fake = fakeMashov({ loginStatus: 401 });
    const c = client(fake);
    await expect(c.getChildren()).rejects.toBeInstanceOf(MashovAuthError);
    expect(fake.logins).toBe(1);
    await expect(c.getChildren()).rejects.toBeInstanceOf(MashovAuthError);
    expect(fake.logins).toBe(1); // backoff: no second POST
  });

  it('retries a rejected login after the backoff expires', async () => {
    let t = new Date('2026-11-10T10:00:00').getTime();
    const fake = fakeMashov({ loginStatus: 401 });
    const c = client(fake, { now: () => new Date(t), authBackoffMs: 1000 });
    await expect(c.getChildren()).rejects.toBeInstanceOf(MashovAuthError);
    t += 1001;
    await expect(c.getChildren()).rejects.toBeInstanceOf(MashovAuthError);
    expect(fake.logins).toBe(2);
  });

  it('detects a forced password change by header', async () => {
    const fake = fakeMashov({ loginStatus: 403, loginHeaders: { reason: 'changepass' } });
    await expect(client(fake).getChildren()).rejects.toBeInstanceOf(MashovPasswordChangeError);
  });

  it('detects a forced password change by message', async () => {
    const fake = fakeMashov({
      loginStatus: 401,
      loginBody: { message: 'Please Change Password before authenticating' },
    });
    await expect(client(fake).getChildren()).rejects.toBeInstanceOf(MashovPasswordChangeError);
  });

  it('never puts credentials in error messages', async () => {
    for (const status of [401, 403, 500]) {
      const fake = fakeMashov({
        loginStatus: status,
        loginBody: { message: `echo ${CREDS.password} ${CREDS.username}` },
      });
      const err = await client(fake)
        .getChildren()
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String((err as Error).message)).not.toContain(CREDS.password);
      expect(String((err as Error).message)).not.toContain(CREDS.username);
    }
  });

  it('logs in again when the school year rolls over', async () => {
    let now = new Date('2026-08-31T10:00:00');
    const fake = fakeMashov();
    const c = client(fake, { now: () => now });
    await c.getChildren();
    now = new Date('2026-09-01T10:00:00');
    await c.getChildren();
    expect(fake.logins).toBe(2);
    expect(JSON.parse(fake.calls[1].body!).year).toBe(2027);
  });
});

describe('GET', () => {
  it('re-logs in once when the session expires, then succeeds', async () => {
    let expire = true;
    const fake = fakeMashov({
      route: (path) => {
        if (path === 'holidays' && expire) {
          expire = false;
          return new Response('{}', { status: 401 });
        }
        return undefined;
      },
    });
    const c = client(fake);
    await expect(c.get('holidays', 'holidays')).resolves.toBeInstanceOf(Array);
    expect(fake.logins).toBe(2);
  });

  it('gives up after one re-login', async () => {
    const fake = fakeMashov({ route: (p) => (p === 'holidays' ? new Response('{}', { status: 401 }) : undefined) });
    await expect(client(fake).get('holidays', 'holidays')).rejects.toThrow(/session rejected/);
    expect(fake.logins).toBe(2);
  });

  it('maps 403 changepass, 403 and 404', async () => {
    const fake = fakeMashov({
      route: (p) => {
        if (p === 'a') return new Response('{}', { status: 403, headers: { reason: 'changepass' } });
        if (p === 'b') return new Response('{}', { status: 403 });
        return undefined;
      },
    });
    const c = client(fake);
    await expect(c.get('a', 'a')).rejects.toBeInstanceOf(MashovPasswordChangeError);
    await expect(c.get('b', 'b')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(c.get('nope', 'nope')).rejects.toBeInstanceOf(MashovUnavailableError);
  });

  it('only ever sends GET after the login POST', async () => {
    const fake = fakeMashov();
    const c = client(fake);
    await c.getChildren();
    for (const p of [
      'students/guid-aaaa-1111/homework?from=2026-11-01&to=2026-11-20&year=2027',
      'students/guid-aaaa-1111/grades',
      'holidays',
      'mail/counts',
    ])
      await c.get(p, 'x');
    const methods = fake.calls.map((c) => `${c.method} ${c.url.slice(API.length).split('?')[0]}`);
    expect(methods[0]).toBe('POST login');
    expect(methods.slice(1).every((m) => m.startsWith('GET '))).toBe(true);
    expect(fake.calls.slice(1).every((c) => c.body === undefined)).toBe(true);
  });
});
