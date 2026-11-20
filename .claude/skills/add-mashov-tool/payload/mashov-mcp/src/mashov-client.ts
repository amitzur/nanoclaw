/**
 * Minimal read-only Mashov client.
 *
 * - One POST (login). Every other request is a GET; nothing is ever submitted,
 *   marked read, or downloaded.
 * - Session state (cookies, CSRF token, roster) lives in memory only. Nothing is
 *   written to disk.
 * - Errors and logs never contain the username, password, cookies, CSRF token,
 *   child names, or child ids.
 */
import { randomUUID } from 'node:crypto';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface Child {
  /** childGuid. Internal only: never returned to callers or logged. */
  guid: string;
  firstName: string;
  familyName: string;
  classCode: string;
  classNum: string;
}

export interface MashovClientOptions {
  semel: number;
  username: string;
  password: string;
  year?: number;
  apiBase: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** After a rejected login, refuse further attempts for this long (avoids account lockout). */
  authBackoffMs?: number;
}

export class MashovError extends Error {
  constructor(
    message: string,
    readonly code: string = 'error',
  ) {
    super(message);
    this.name = 'MashovError';
  }
}
export class MashovAuthError extends MashovError {
  constructor(message = 'Mashov rejected the login. Check the username, password, semel and year on the host.') {
    super(message, 'auth');
    this.name = 'MashovAuthError';
  }
}
export class MashovPasswordChangeError extends MashovError {
  constructor() {
    super(
      'Mashov requires a password change. Log in at https://web.mashov.info, change it, then update the host config.',
      'changepass',
    );
    this.name = 'MashovPasswordChangeError';
  }
}
/** The school disabled or does not support this resource (HTTP 403/404). */
export class MashovUnavailableError extends MashovError {
  constructor(resource: string, status: number) {
    super(
      `Mashov resource "${resource}" is ${status === 404 ? 'not supported' : 'not available'} for this school`,
      status === 404 ? 'unsupported' : 'forbidden',
    );
    this.name = 'MashovUnavailableError';
  }
}

/** Mashov school years are named after the calendar year they end in (rollover on Sept 1st). */
export function mashovYear(d: Date): number {
  return d.getMonth() + 1 >= 9 ? d.getFullYear() + 1 : d.getFullYear();
}

const LOGIN_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json;charset=UTF-8',
  Origin: 'https://web.mashov.info',
  Referer: 'https://web.mashov.info/students/login',
  'User-Agent': 'Mozilla/5.0 (NanoClaw) mashov-mcp/0.1',
};

function isChangePass(res: Response, body: string): boolean {
  const reason = (res.headers.get('reason') ?? '').trim().toLowerCase();
  if (reason === 'changepass') return true;
  let message = body;
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (parsed && typeof parsed.message === 'string') message = parsed.message;
  } catch {
    /* plain text body */
  }
  return message.toLowerCase().includes('change password');
}

function getSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

export class MashovClient {
  private readonly opts: Required<Omit<MashovClientOptions, 'year'>> & { year?: number };
  private readonly deviceUuid = randomUUID();
  private cookies = new Map<string, string>();
  private csrf: string | null = null;
  private children: Child[] | null = null;
  private sessionYear: number | null = null;
  private loginInFlight: Promise<void> | null = null;
  private authBlockedUntil = 0;
  private authBlockedError: MashovError | null = null;

  constructor(opts: MashovClientOptions) {
    this.opts = {
      fetch: (url, init) => fetch(url, init),
      now: () => new Date(),
      authBackoffMs: 15 * 60 * 1000,
      ...opts,
    };
  }

  get year(): number {
    return this.opts.year ?? mashovYear(this.opts.now());
  }

  private cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private storeCookies(res: Response): void {
    for (const line of getSetCookies(res.headers)) {
      const pair = line.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private clearSession(): void {
    this.cookies.clear();
    this.csrf = null;
    this.children = null;
    this.sessionYear = null;
  }

  /** Log in if there is no session, or the school year rolled over. */
  async ensureSession(): Promise<void> {
    if (this.csrf && this.children && this.sessionYear === this.year) return;
    await this.login();
  }

  /** Single-flight login: concurrent callers share one POST. */
  login(): Promise<void> {
    if (!this.loginInFlight) {
      this.loginInFlight = this.doLogin().finally(() => {
        this.loginInFlight = null;
      });
    }
    return this.loginInFlight;
  }

  private async doLogin(): Promise<void> {
    const nowMs = this.opts.now().getTime();
    if (this.authBlockedError && nowMs < this.authBlockedUntil) throw this.authBlockedError;
    this.clearSession();
    const year = this.year;
    const payload = {
      semel: this.opts.semel,
      year,
      username: this.opts.username,
      password: this.opts.password,
      IsBiometric: false,
      appName: 'info.mashov.students',
      apiVersion: '4.20250101',
      appVersion: '4.20250101',
      appBuild: '4.20250101',
      deviceUuid: this.deviceUuid,
      devicePlatform: 'chrome',
      deviceManufacturer: 'nanoclaw',
      deviceModel: 'mashov-mcp',
      deviceVersion: '0.1.0',
    };
    let res: Response;
    try {
      res = await this.opts.fetch(this.opts.apiBase + 'login', {
        method: 'POST',
        headers: LOGIN_HEADERS,
        body: JSON.stringify(payload),
        redirect: 'manual',
      });
    } catch {
      throw new MashovError('Could not reach Mashov (network error during login)', 'network');
    }
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => '');
      const err = isChangePass(res, body) ? new MashovPasswordChangeError() : new MashovAuthError();
      this.authBlockedError = err;
      this.authBlockedUntil = nowMs + this.opts.authBackoffMs;
      throw err;
    }
    if (res.status >= 400) throw new MashovError(`Mashov login failed (HTTP ${res.status})`, `http_${res.status}`);
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new MashovError('Mashov login returned an unexpected response', 'invalid_response');
    }
    const accessToken = (data as { accessToken?: unknown })?.accessToken;
    const rawChildren = (accessToken as { children?: unknown } | undefined)?.children;
    if (!Array.isArray(rawChildren)) throw new MashovError('Mashov login returned no children', 'no_children');
    const children: Child[] = [];
    for (const c of rawChildren as Record<string, unknown>[]) {
      if (!c || typeof c.childGuid !== 'string' || !c.childGuid) continue;
      children.push({
        guid: c.childGuid,
        firstName: String(c.privateName ?? '').trim(),
        familyName: String(c.familyName ?? '').trim(),
        classCode: String(c.classCode ?? '').trim(),
        classNum: c.classNum === undefined || c.classNum === null ? '' : String(c.classNum).trim(),
      });
    }
    if (children.length === 0) throw new MashovError('Mashov login returned no children', 'no_children');
    const csrf = res.headers.get('x-csrf-token');
    if (!csrf) throw new MashovError('Mashov login returned no CSRF token', 'no_csrf');
    this.storeCookies(res);
    this.csrf = csrf;
    this.children = children;
    this.sessionYear = year;
    this.authBlockedError = null;
    this.authBlockedUntil = 0;
  }

  async getChildren(): Promise<Child[]> {
    await this.ensureSession();
    return [...(this.children ?? [])];
  }

  /**
   * GET a path under the API base. Re-logs in once on 401. `resource` is a
   * short label used in errors (never the URL, which contains the child id).
   */
  async get(path: string, resource: string): Promise<unknown> {
    await this.ensureSession();
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': LOGIN_HEADERS['User-Agent'],
      };
      if (this.csrf) headers['X-Csrf-Token'] = this.csrf;
      const cookie = this.cookieHeader();
      if (cookie) headers.Cookie = cookie;
      let res: Response;
      try {
        res = await this.opts.fetch(this.opts.apiBase + path, { method: 'GET', headers, redirect: 'manual' });
      } catch {
        throw new MashovError(`Could not reach Mashov while fetching ${resource}`, 'network');
      }
      if (res.status === 401) {
        if (attempt === 0) {
          await this.login();
          continue;
        }
        throw new MashovError(`Mashov session rejected while fetching ${resource}`, 'unauthorized');
      }
      if (res.status === 403) {
        const body = await res.text().catch(() => '');
        if (isChangePass(res, body)) throw new MashovPasswordChangeError();
        throw new MashovUnavailableError(resource, 403);
      }
      if (res.status === 404) throw new MashovUnavailableError(resource, 404);
      if (res.status >= 300)
        throw new MashovError(`Mashov returned HTTP ${res.status} for ${resource}`, `http_${res.status}`);
      this.storeCookies(res);
      try {
        return await res.json();
      } catch {
        throw new MashovError(`Mashov returned invalid JSON for ${resource}`, 'invalid_response');
      }
    }
    throw new MashovError(`Mashov session rejected while fetching ${resource}`, 'unauthorized');
  }
}
