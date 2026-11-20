import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertPrivateFile, ConfigError, defaultBind, loadConfig, parseConfig } from '../src/config.js';
import { check, configure, parseArgs, parseCredentialsFile, printToken } from '../src/setup-cli.js';
import { CREDS } from './fake-mashov.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mashov-cfg-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const valid = { semel: 999999, username: 'u', password: 'p', bearerToken: 'b'.repeat(43) };

describe('config', () => {
  it('defaults the bind address to the docker bridge on Linux, loopback elsewhere', () => {
    expect(defaultBind('linux')).toBe('172.17.0.1');
    expect(defaultBind('darwin')).toBe('127.0.0.1');
    expect(parseConfig(valid, 'linux')).toMatchObject({ bind: '172.17.0.1', port: 8787 });
  });

  it('validates fields without echoing values', () => {
    expect(() => parseConfig({ ...valid, bearerToken: 'short' })).toThrow(/bearerToken/);
    expect(() => parseConfig({ ...valid, semel: 'abc' })).toThrow(/semel/);
    const err = (() => {
      try {
        parseConfig({ ...valid, password: '', username: 'leaky-user' });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err!.message).not.toContain('leaky-user');
  });

  it('refuses a group/world-readable config file', () => {
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, JSON.stringify(valid), { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    expect(() => loadConfig(f)).toThrow(/chmod 600/);
    fs.chmodSync(f, 0o600);
    expect(loadConfig(f).semel).toBe(999999);
  });
});

describe('setup-cli', () => {
  it('parses args and rejects unknown options', () => {
    expect(parseArgs(['check', '--login']).flags.get('login')).toBe(true);
    expect(() => parseArgs(['configure', '--password', 'x'])).toThrow(ConfigError);
  });

  it('parses KEY=VALUE credentials', () => {
    expect(parseCredentialsFile('# c\nsemel=1\nusername = "a b"\npassword=p=q\n')).toEqual({
      semel: '1',
      username: 'a b',
      password: 'p=q',
    });
    expect(() => parseCredentialsFile('token=x')).toThrow(/unknown key/);
  });

  it('configure --from-file writes a 0600 config, generates a token, deletes the input, prints no secrets', async () => {
    const creds = path.join(dir, 'creds');
    fs.writeFileSync(creds, `semel=${CREDS.semel}\nusername=${CREDS.username}\npassword=${CREDS.password}\n`, {
      mode: 0o600,
    });
    const cfgFile = path.join(dir, 'sub', 'config.json');
    const out: string[] = [];
    await configure(
      new Map<string, string | true>([
        ['from-file', creds],
        ['bind', '127.0.0.1'],
      ]),
      cfgFile,
      (s) => out.push(s),
    );
    expect(fs.existsSync(creds)).toBe(false);
    expect(fs.statSync(cfgFile).mode & 0o777).toBe(0o600);
    const cfg = loadConfig(cfgFile);
    expect(cfg).toMatchObject({ ...CREDS, bind: '127.0.0.1', port: 8787 });
    expect(cfg.bearerToken.length).toBeGreaterThanOrEqual(43);
    const printed = out.join('\n');
    for (const s of [CREDS.password, CREDS.username, cfg.bearerToken]) expect(printed).not.toContain(s);
    expect(printed).toMatch(/generated/);

    // Re-running keeps the token (idempotent), --rotate-token replaces it.
    fs.writeFileSync(creds, `password=new-${CREDS.password}\n`, { mode: 0o600 });
    await configure(new Map([['from-file', creds]]), cfgFile, () => {});
    expect(loadConfig(cfgFile).bearerToken).toBe(cfg.bearerToken);
    expect(loadConfig(cfgFile).password).toBe(`new-${CREDS.password}`);
    expect(loadConfig(cfgFile).username).toBe(CREDS.username);
    fs.writeFileSync(creds, '', { mode: 0o600 });
    await configure(
      new Map<string, string | true>([
        ['from-file', creds],
        ['rotate-token', true],
      ]),
      cfgFile,
      () => {},
    );
    expect(loadConfig(cfgFile).bearerToken).not.toBe(cfg.bearerToken);
  });

  it('configure refuses a readable credentials file', async () => {
    const creds = path.join(dir, 'creds');
    fs.writeFileSync(creds, 'semel=1\n', { mode: 0o644 });
    fs.chmodSync(creds, 0o644);
    await expect(configure(new Map([['from-file', creds]]), path.join(dir, 'c.json'), () => {})).rejects.toThrow(
      /chmod 600/,
    );
    expect(() => assertPrivateFile(creds)).toThrow();
  });

  it('check prints a summary without secrets', async () => {
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, JSON.stringify({ ...valid, username: CREDS.username, password: CREDS.password }), {
      mode: 0o600,
    });
    const out: string[] = [];
    await check(new Map(), f, (s) => out.push(s));
    expect(out.join('')).toMatch(/config ok/);
    expect(out.join('')).not.toContain(CREDS.password);
    expect(out.join('')).not.toContain(CREDS.username);
  });

  it('print-token refuses a terminal and writes the bare token otherwise', () => {
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, JSON.stringify(valid), { mode: 0o600 });
    const tty = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
    expect(() => printToken(f, tty)).toThrow(/terminal/);
    const pipe = new PassThrough();
    printToken(f, pipe as unknown as NodeJS.WriteStream);
    expect(pipe.read().toString()).toBe(valid.bearerToken);
  });
});

describe('endpoint + tls config', () => {
  it('prints scheme, bind and port only', async () => {
    const { endpoint } = await import('../src/setup-cli.js');
    const f = path.join(dir, 'config.json');
    fs.writeFileSync(f, JSON.stringify({ ...valid, bind: '172.17.0.1' }), { mode: 0o600 });
    expect(endpoint(f)).toBe('http 172.17.0.1 8787');
    fs.writeFileSync(f, JSON.stringify({ ...valid, bind: '172.17.0.1', tlsCertFile: '/c.pem', tlsKeyFile: '/k.pem' }), {
      mode: 0o600,
    });
    expect(endpoint(f)).toBe('https 172.17.0.1 8787');
  });
  it('requires cert and key together', () => {
    expect(() => parseConfig({ ...valid, tlsCertFile: '/c.pem' })).toThrow(/go together/);
  });
});
