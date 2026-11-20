/**
 * Host-only configuration for the Mashov MCP server.
 *
 * The config file holds the Mashov username/password and the MCP bearer token,
 * so it must be owned by the operator and readable only by them (mode 0600).
 * Nothing in this file is ever logged or returned to a caller.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface MashovConfig {
  /** School code ("semel"), see https://web.mashov.info/api/schools */
  semel: number;
  username: string;
  password: string;
  /** Pinned school year; omit to follow the Mashov year (rolls over on Sept 1st). */
  year?: number;
  /** Bearer token the OneCLI gateway injects for permitted agents. */
  bearerToken: string;
  /** Interface to listen on. */
  bind: string;
  port: number;
  /** Mashov API base, overridable for tests only. */
  apiBase: string;
  /** Optional PEM cert/key paths: serve HTTPS instead of HTTP (fallback, see docs/mashov.md). */
  tlsCertFile?: string;
  tlsKeyFile?: string;
}

export const DEFAULT_PORT = 8787;
export const DEFAULT_API_BASE = 'https://web.mashov.info/api/';

/**
 * Default bind address. On Linux, containers reach the host on the docker0
 * bridge IP, so binding there keeps the server off every other interface
 * (LAN, VPN, public). On macOS, Docker Desktop forwards host.docker.internal
 * to the host loopback, so 127.0.0.1 is enough and never exposes the port.
 */
export function defaultBind(platform: NodeJS.Platform = process.platform): string {
  return platform === 'linux' ? '172.17.0.1' : '127.0.0.1';
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MASHOV_MCP_CONFIG) return env.MASHOV_MCP_CONFIG;
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'nanoclaw-mashov', 'config.json');
}

export class ConfigError extends Error {}

/** Throws unless the file exists and only its owner can read/write it. */
export function assertPrivateFile(file: string): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new ConfigError(`config file not found: ${file}`);
  }
  if (!st.isFile()) throw new ConfigError(`config path is not a regular file: ${file}`);
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw new ConfigError(
      `config file ${file} is accessible by group/others (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${file}`,
    );
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Validate a raw object. Error messages name the bad field, never its value. */
export function parseConfig(raw: unknown, platform: NodeJS.Platform = process.platform): MashovConfig {
  if (!raw || typeof raw !== 'object') throw new ConfigError('config must be a JSON object');
  const r = raw as Record<string, unknown>;
  const semel = Number(r.semel);
  if (!Number.isInteger(semel) || semel <= 0) throw new ConfigError('config.semel must be a positive integer');
  const username = str(r.username);
  if (!username) throw new ConfigError('config.username is required');
  const password = str(r.password);
  if (!password) throw new ConfigError('config.password is required');
  const bearerToken = str(r.bearerToken);
  if (!bearerToken || bearerToken.length < 32) throw new ConfigError('config.bearerToken must be at least 32 chars');
  let year: number | undefined;
  if (r.year !== undefined && r.year !== null && r.year !== '') {
    year = Number(r.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ConfigError('config.year must be a year');
  }
  const port = r.port === undefined ? DEFAULT_PORT : Number(r.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ConfigError('config.port is invalid');
  const bind = str(r.bind) ?? defaultBind(platform);
  const apiBase = str(r.apiBase) ?? DEFAULT_API_BASE;
  const tlsCertFile = str(r.tlsCertFile);
  const tlsKeyFile = str(r.tlsKeyFile);
  if (!!tlsCertFile !== !!tlsKeyFile) throw new ConfigError('config.tlsCertFile and config.tlsKeyFile go together');
  return {
    semel,
    username,
    password,
    year,
    bearerToken,
    bind,
    port,
    apiBase: apiBase.endsWith('/') ? apiBase : apiBase + '/',
    tlsCertFile,
    tlsKeyFile,
  };
}

export function loadConfig(file: string = defaultConfigPath()): MashovConfig {
  assertPrivateFile(file);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new ConfigError(`config file ${file} is not valid JSON`);
  }
  return parseConfig(raw);
}

/** Write the config atomically with mode 0600 (directory 0700). */
export function writeConfig(file: string, cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
