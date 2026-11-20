/**
 * Tiny structured logger. Callers pass only non-sensitive fields (tool name,
 * status code, duration, listen address); there is deliberately no way to log
 * a request body, a tool argument, or a Mashov response.
 */
export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export function createLogger(write: (line: string) => void = (l) => process.stderr.write(l + '\n')): Logger {
  const emit = (level: string, msg: string, fields?: LogFields) =>
    write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }));
  return {
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}
