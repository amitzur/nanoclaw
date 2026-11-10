#!/usr/bin/env node
/**
 * Host-side setup helper. Credentials are read from a 0600 file or typed at a
 * no-echo prompt; they never appear on argv and are never printed.
 *
 *   node dist/setup-cli.js configure [--from-file F] [--bind IP] [--port N] [--rotate-token]
 *   node dist/setup-cli.js print-token > "$(mktemp)"   # refuses to print to a terminal
 *   node dist/setup-cli.js check [--login]
 *   node dist/setup-cli.js endpoint            # "<http|https> <bind> <port>", no secrets
 *
 * All commands accept --config PATH (default $MASHOV_MCP_CONFIG or
 * ~/.config/nanoclaw-mashov/config.json).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import {
  assertPrivateFile,
  ConfigError,
  defaultBind,
  defaultConfigPath,
  DEFAULT_PORT,
  loadConfig,
  parseConfig,
  writeConfig,
} from './config.js';
import { MashovClient, MashovError } from './mashov-client.js';

const USAGE = `usage: setup-cli <configure|print-token|check> [options]
  configure    [--from-file F] [--bind IP] [--port N] [--rotate-token] [--config PATH]
  print-token  [--config PATH]          (stdout must be redirected, e.g. to a 0600 temp file)
  check        [--login] [--config PATH]
  endpoint     [--config PATH]          (prints "<http|https> <bind> <port>")`;

export interface Args {
  cmd: string;
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const [cmd = '', ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new ConfigError(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (['login', 'rotate-token'].includes(key)) flags.set(key, true);
    else if (['from-file', 'bind', 'port', 'config'].includes(key)) {
      const v = rest[++i];
      if (v === undefined) throw new ConfigError(`--${key} needs a value`);
      flags.set(key, v);
    } else throw new ConfigError(`unknown option --${key}`);
  }
  return { cmd, flags };
}

/** Parse a KEY=VALUE credentials file (blank lines and # comments ignored). */
export function parseCredentialsFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) throw new ConfigError('credentials file: every line must be KEY=VALUE');
    const key = line.slice(0, eq).trim().toLowerCase();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    if (!['semel', 'username', 'password', 'year'].includes(key))
      throw new ConfigError(`credentials file: unknown key "${key}"`);
    out[key] = value;
  }
  return out;
}

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      const rlAny = rl as unknown as { _writeToOutput: (s: string) => void };
      rlAny._writeToOutput = (s: string) => {
        if (s.startsWith(question)) process.stderr.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stderr.write('\n');
      resolve(answer.trim());
    });
  });
}

function readExisting(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  assertPrivateFile(file);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new ConfigError(`existing config ${file} is not valid JSON`);
  }
}

export async function configure(
  flags: Map<string, string | true>,
  file: string,
  out: (s: string) => void,
): Promise<void> {
  const existing = readExisting(file);
  let creds: Record<string, string>;
  const fromFile = flags.get('from-file');
  if (typeof fromFile === 'string') {
    assertPrivateFile(fromFile);
    creds = parseCredentialsFile(fs.readFileSync(fromFile, 'utf8'));
  } else {
    if (!process.stdin.isTTY)
      throw new ConfigError('no terminal for prompts; use --from-file with a 0600 file instead');
    creds = {};
    creds.semel =
      (await ask(`School semel${existing.semel ? ` [${existing.semel}]` : ''}: `)) || String(existing.semel ?? '');
    creds.username = (await ask('Mashov username (parent ID number): ')) || String(existing.username ?? '');
    creds.password = (await ask('Mashov password (hidden): ', true)) || String(existing.password ?? '');
  }
  const bearerToken =
    flags.get('rotate-token') || typeof existing.bearerToken !== 'string'
      ? randomBytes(32).toString('base64url')
      : existing.bearerToken;
  const next: Record<string, unknown> = {
    ...existing,
    semel: Number(creds.semel ?? existing.semel),
    username: creds.username ?? existing.username,
    password: creds.password ?? existing.password,
    bearerToken,
    bind: typeof flags.get('bind') === 'string' ? flags.get('bind') : (existing.bind ?? defaultBind()),
    port: typeof flags.get('port') === 'string' ? Number(flags.get('port')) : (existing.port ?? DEFAULT_PORT),
  };
  if (creds.year !== undefined) next.year = creds.year === '' ? undefined : Number(creds.year);
  const cfg = parseConfig(next); // validate before writing
  writeConfig(file, next);
  if (typeof fromFile === 'string') fs.rmSync(fromFile, { force: true });
  out(
    `wrote ${file} (mode 600): semel=${cfg.semel} bind=${cfg.bind} port=${cfg.port}; bearer token ${
      bearerToken === existing.bearerToken ? 'kept' : 'generated'
    }${typeof fromFile === 'string' ? '; credentials file removed' : ''}`,
  );
}

export async function check(flags: Map<string, string | true>, file: string, out: (s: string) => void): Promise<void> {
  const cfg = loadConfig(file);
  out(`config ok: ${file} semel=${cfg.semel} bind=${cfg.bind} port=${cfg.port}${cfg.year ? ` year=${cfg.year}` : ''}`);
  if (flags.get('login')) {
    const client = new MashovClient({
      semel: cfg.semel,
      username: cfg.username,
      password: cfg.password,
      year: cfg.year,
      apiBase: cfg.apiBase,
    });
    const children = await client.getChildren();
    out(`login ok: ${children.length} ${children.length === 1 ? 'child' : 'children'} (year ${client.year})`);
  }
}

export function printToken(file: string, stdout: NodeJS.WriteStream = process.stdout): void {
  if (stdout.isTTY)
    throw new ConfigError('refusing to print the bearer token to a terminal; redirect stdout to a 0600 file');
  stdout.write(loadConfig(file).bearerToken);
}

export function endpoint(file: string): string {
  const cfg = loadConfig(file);
  return `${cfg.tlsCertFile ? 'https' : 'http'} ${cfg.bind} ${cfg.port}`;
}

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  const file = typeof flags.get('config') === 'string' ? (flags.get('config') as string) : defaultConfigPath();
  const out = (s: string) => process.stderr.write(s + '\n');
  if (cmd === 'configure') await configure(flags, file, out);
  else if (cmd === 'check') await check(flags, file, (s) => process.stdout.write(s + '\n'));
  else if (cmd === 'print-token') printToken(file);
  else if (cmd === 'endpoint') process.stdout.write(endpoint(file) + '\n');
  else {
    out(USAGE);
    process.exit(2);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) {
  main().catch((err: unknown) => {
    const msg = err instanceof ConfigError || err instanceof MashovError ? err.message : 'unexpected error';
    process.stderr.write(`error: ${msg}\n`);
    process.exit(1);
  });
}
