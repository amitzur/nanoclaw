#!/usr/bin/env node
/** Entry point: `node dist/main.js` (config from $MASHOV_MCP_CONFIG or ~/.config/nanoclaw-mashov/config.json). */
import fs from 'node:fs';

import { ConfigError, defaultConfigPath, loadConfig } from './config.js';
import { createHttpServer, MCP_PATH } from './http.js';
import { createLogger } from './log.js';
import { MashovClient } from './mashov-client.js';

const log = createLogger();

function main(): void {
  const file = defaultConfigPath();
  let cfg;
  try {
    cfg = loadConfig(file);
  } catch (err) {
    log.error(err instanceof ConfigError ? err.message : 'failed to load config', { file });
    process.exit(78); // EX_CONFIG: systemd/launchd keep retrying, which is fine once fixed
  }
  const client = new MashovClient({
    semel: cfg.semel,
    username: cfg.username,
    password: cfg.password,
    year: cfg.year,
    apiBase: cfg.apiBase,
  });
  let tls: { cert: Buffer; key: Buffer } | undefined;
  if (cfg.tlsCertFile && cfg.tlsKeyFile) {
    try {
      tls = { cert: fs.readFileSync(cfg.tlsCertFile), key: fs.readFileSync(cfg.tlsKeyFile) };
    } catch {
      log.error('cannot read tlsCertFile/tlsKeyFile', { file });
      process.exit(78);
    }
  }
  const server = createHttpServer({ bearerToken: cfg.bearerToken, client, log }, tls);
  server.on('error', (err: NodeJS.ErrnoException) => {
    log.error('listen failed', { bind: cfg.bind, port: cfg.port, code: err.code });
    process.exit(1);
  });
  server.listen(cfg.port, cfg.bind, () => {
    log.info('listening', { bind: cfg.bind, port: cfg.port, path: MCP_PATH, tls: !!tls });
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
