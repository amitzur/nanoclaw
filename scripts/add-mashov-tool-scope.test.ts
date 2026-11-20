// Behavior tests for the /add-mashov-tool skill's host-side steps.
//
// The skill carries its install as `nc:` directive fences. The conformance
// suite proves those fences apply against a stubbed exec, but it doesn't check
// what the shell inside them does. These tests take the real one-liners out of
// SKILL.md: the typo guard, the vault upsert, the three per-agent scoping steps,
// the URL capture, and the per-group MCP registration. They run each one under
// POSIX `sh` in a throwaway project root, against stateful stub `onecli` and
// `ncl` binaries and a stand-in `setup-cli.js`. Then they assert which agents
// end up allowed or blocked, which groups end up with the MCP server, and the
// exact commands issued.
//
// Contract under test:
//   - a chosen group has no "Mashov: blocked for <group>" rule and does have a
//     `mashov` MCP server; every other group has the rule present and enabled,
//     path-scoped to /mashov/*, and no `mashov` server;
//   - the bearer token reaches OneCLI only through a 0600 temp file that is
//     removed afterwards, never on argv or stdout;
//   - set-secrets is never called on an `all`-mode agent;
//   - the operator's own rules on host.docker.internal are never touched;
//   - the URL the skill registers is one core accepts as an http MCP server.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseMcpServerConfig } from '../src/container-config.js';
import { parseDirectives, type Directive } from './skill-directives.js';

const SKILL_DIR = path.resolve(__dirname, '../.claude/skills/add-mashov-tool');
const directives = parseDirectives(fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8'));
const one = (pred: (d: Directive) => boolean): string => {
  const hits = directives.filter(pred);
  if (hits.length !== 1) throw new Error(`expected exactly one matching directive, found ${hits.length}`);
  if (hits[0].body.length !== 1) throw new Error(`directive at line ${hits[0].line} must be a single command`);
  return hits[0].body[0];
};
const isRun = (effect: string, needle: string) => (d: Directive) =>
  d.kind === 'run' && d.attrs.effect === effect && d.body.join('\n').includes(needle);

const CMD = {
  typoGuard: one(isRun('check', 'unknown agent group')),
  credential: one(isRun('external', 'onecli secrets')),
  ensureAgents: one(isRun('wire', 'onecli agents create')),
  allowBlock: one(isRun('wire', 'onecli rules create')),
  selectiveMerge: one(isRun('wire', 'set-secrets')),
  urlCapture: one((d) => d.kind === 'run' && d.attrs.capture === 'mashov_url'),
  register: one(isRun('wire', 'add-mcp-server')),
};

const TOKEN = 'synthetic-token-0123456789abcdef0123456789abcdef';

type OcAgent = { id: string; identifier: string; name: string; secretMode: 'all' | 'selective' };
type Rule = {
  id: string;
  agentId: string;
  name: string;
  enabled?: boolean;
  hostPattern?: string;
  pathPattern?: string | null;
};

const GROUPS = [
  { id: 'ag-family', name: 'Family' },
  { id: 'ag-work', name: 'Work' },
];
const DEFAULT_AGENTS: OcAgent[] = [
  { id: 'oc-default', identifier: 'default', name: 'Default Agent', secretMode: 'all' },
  { id: 'oc-family', identifier: 'ag-family', name: 'Family', secretMode: 'selective' },
];

let root: string;
let bin: string;
let state: string;
let calls: string;

function writeStub(name: string, body: string): void {
  fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "$CALLS"\n${body}\n`, {
    mode: 0o755,
  });
}

function setup(
  opts: {
    rules?: Rule[];
    agents?: OcAgent[];
    secrets?: Array<{ id: string; name: string }>;
    /** mcp_servers per group id. */
    servers?: Record<string, Record<string, unknown>>;
    /** Whether the stand-in setup-cli has a token to print. */
    token?: boolean;
    scheme?: 'http' | 'https';
  } = {},
): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'add-mashov-tool-'));
  bin = path.join(root, 'bin');
  state = path.join(root, 'state');
  calls = path.join(root, 'calls.log');
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  fs.writeFileSync(calls, '');

  const cli = path.join(root, 'tools/mashov-mcp/dist/setup-cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(
    cli,
    `const c = process.argv[2];
if (c === 'endpoint') { console.log('${opts.scheme ?? 'http'} 172.17.0.1 8787'); }
else if (c === 'print-token') { ${opts.token === false ? "console.error('no config'); process.exit(78);" : `console.log('${TOKEN}');`} }
else process.exit(64);
`,
  );

  const rules = (opts.rules ?? []).map((r) => ({
    enabled: true,
    pathPattern: '/mashov/*',
    method: null,
    hostPattern: 'host.docker.internal',
    action: 'block',
    ...r,
  }));
  fs.writeFileSync(path.join(state, 'agents.json'), JSON.stringify({ data: opts.agents ?? DEFAULT_AGENTS }));
  fs.writeFileSync(path.join(state, 'rules.json'), JSON.stringify({ data: rules }));
  fs.writeFileSync(path.join(state, 'assigned.json'), JSON.stringify({ data: ['sec-anthropic'] }));
  fs.writeFileSync(
    path.join(state, 'secrets.json'),
    JSON.stringify({ data: opts.secrets ?? [{ id: 'sec-mashov', name: 'Mashov MCP' }] }),
  );
  for (const g of GROUPS) {
    fs.writeFileSync(path.join(state, `cfg-${g.id}.json`), JSON.stringify(opts.servers?.[g.id] ?? {}));
  }

  writeStub(
    'ncl',
    `
S="$STATE"
arg() { local k="$1"; shift; while [ $# -gt 0 ]; do if [ "$1" = "$k" ]; then echo "$2"; return; fi; shift; done; }
case "$1 $2 $3" in
  "groups list --json") echo '${JSON.stringify({ ok: true, data: GROUPS })}' ;;
  "groups config get") i=$(arg --id "$@"); jq '{ok:true,data:{mcp_servers:.}}' "$S/cfg-$i.json" ;;
  "groups config add-mcp-server") i=$(arg --id "$@"); n=$(arg --name "$@"); u=$(arg --url "$@"); jq --arg n "$n" --arg u "$u" '.[$n]={type:"http",url:$u}' "$S/cfg-$i.json" > "$S/t" && mv "$S/t" "$S/cfg-$i.json"; echo '{"ok":true}' ;;
  "groups config remove-mcp-server") i=$(arg --id "$@"); n=$(arg --name "$@"); jq -e --arg n "$n" 'has($n)' "$S/cfg-$i.json" >/dev/null || { echo "not found" >&2; exit 1; }; jq --arg n "$n" 'del(.[$n])' "$S/cfg-$i.json" > "$S/t" && mv "$S/t" "$S/cfg-$i.json"; echo '{"ok":true}' ;;
  *) echo '{}' ;;
esac`,
  );
  writeStub(
    'onecli',
    `
S="$STATE"
arg() { local k="$1"; shift; while [ $# -gt 0 ]; do if [ "$1" = "$k" ]; then echo "$2"; return; fi; shift; done; }
case "$1 $2" in
  "secrets list") cat "$S/secrets.json" ;;
  "secrets delete") i=$(arg --id "$@"); jq --arg i "$i" '.data |= map(select(.id != $i))' "$S/secrets.json" > "$S/t" && mv "$S/t" "$S/secrets.json"; echo '{}' ;;
  "secrets create") f=$(arg --file "$@"); if find "$f" -perm 600 | grep -q .; then echo 600; else echo other; fi > "$S/key-mode"; cat "$f" > "$S/key-seen"; jq '.data += [{"id":"sec-new","name":"Mashov MCP"}]' "$S/secrets.json" > "$S/t" && mv "$S/t" "$S/secrets.json"; echo '{"id":"sec-new"}' ;;
  "agents list") cat "$S/agents.json" ;;
  "agents secrets") cat "$S/assigned.json" ;;
  "agents set-secrets") echo '{}' ;;
  "agents create") n=$(arg --name "$@"); i=$(arg --identifier "$@"); jq --arg n "$n" --arg i "$i" '.data += [{"id":("oc-"+$i),"identifier":$i,"name":$n,"secretMode":"all"}]' "$S/agents.json" > "$S/t" && mv "$S/t" "$S/agents.json"; echo '{}' ;;
  "rules list") cat "$S/rules.json" ;;
  "rules create") n=$(arg --name "$@"); a=$(arg --agent-id "$@"); h=$(arg --host-pattern "$@"); p=$(arg --path-pattern "$@"); c=$(jq '.data|length' "$S/rules.json"); jq --arg n "$n" --arg a "$a" --arg h "$h" --arg p "$p" --arg id "rule-new-$c" '.data += [{"id":$id,"name":$n,"agentId":$a,"hostPattern":$h,"pathPattern":$p,"action":"block","enabled":true,"method":null}]' "$S/rules.json" > "$S/t" && mv "$S/t" "$S/rules.json"; echo '{}' ;;
  "rules update") i=$(arg --id "$@"); e=$(arg --enabled "$@"); jq --arg i "$i" --argjson e "$e" '(.data[] | select(.id==$i) | .enabled) = $e' "$S/rules.json" > "$S/t" && mv "$S/t" "$S/rules.json"; echo '{}' ;;
  "rules delete") i=$(arg --id "$@"); jq --arg i "$i" '.data |= map(select(.id != $i))' "$S/rules.json" > "$S/t" && mv "$S/t" "$S/rules.json"; echo '{}' ;;
  *) echo '{}' ;;
esac`,
  );
}

function sh(cmd: string, vars: Record<string, string> = {}): { stdout: string; status: number } {
  let substituted = cmd;
  for (const [k, v] of Object.entries(vars)) substituted = substituted.replaceAll(`{{${k}}}`, v);
  try {
    const stdout = execFileSync('sh', ['-c', substituted], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, STATE: state, TMPDIR: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? '', status: err.status ?? 1 };
  }
}

/** The scoping and registration sequence in document order. */
function apply(agents: string): { stdout: string; status: number } {
  const guard = sh(CMD.typoGuard, { mashov_agents: agents });
  if (guard.status !== 0) return guard;
  const url = sh(CMD.urlCapture).stdout.trim();
  let out = '';
  for (const cmd of [CMD.ensureAgents, CMD.allowBlock, CMD.selectiveMerge, CMD.register]) {
    const r = sh(cmd, { mashov_agents: agents, mashov_url: url });
    out += r.stdout;
    if (r.status !== 0) return { stdout: out, status: r.status };
  }
  return { stdout: out, status: 0 };
}

const callLines = () => fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
const rulesNow = (): Rule[] =>
  (JSON.parse(fs.readFileSync(path.join(state, 'rules.json'), 'utf8')) as { data: Rule[] }).data;
const blockedAgentIds = () =>
  rulesNow()
    .filter((r) => r.enabled && r.name.startsWith('Mashov: blocked for '))
    .map((r) => r.agentId)
    .sort();
const serversOf = (gid: string): Record<string, { url?: string }> =>
  JSON.parse(fs.readFileSync(path.join(state, `cfg-${gid}.json`), 'utf8'));

beforeEach(() => setup());
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function reset(opts: Parameters<typeof setup>[0]): void {
  fs.rmSync(root, { recursive: true, force: true });
  setup(opts);
}

describe('add-mashov-tool: the registered URL', () => {
  it('builds a URL core accepts as a plain-http MCP server on host.docker.internal', () => {
    const url = sh(CMD.urlCapture).stdout.trim();
    expect(url).toBe('http://host.docker.internal:8787/mashov/mcp');
    expect(parseMcpServerConfig({ url })).toEqual({ type: 'http', url });
  });

  it('follows the server to https when it serves TLS', () => {
    reset({ scheme: 'https' });
    const url = sh(CMD.urlCapture).stdout.trim();
    expect(url).toBe('https://host.docker.internal:8787/mashov/mcp');
    expect(parseMcpServerConfig({ url })).toEqual({ type: 'http', url });
  });
});

describe('add-mashov-tool: scoping to the chosen agents', () => {
  it('allows and registers the chosen group; blocks the other on /mashov/* and leaves it unregistered', () => {
    const { stdout, status } = apply('ag-family');
    expect(status).toBe(0);
    expect(stdout).toContain('allowed: Family (ag-family)');
    expect(stdout).toContain('blocked: Work (ag-work)');
    expect(stdout).toContain('registered: ag-family');

    const lines = callLines();
    expect(lines).toContain('onecli agents create --name Work --identifier ag-work');
    expect(lines).toContain(
      'onecli rules create --name Mashov: blocked for Work --host-pattern host.docker.internal --path-pattern /mashov/* --action block --agent-id oc-ag-work --enabled',
    );
    expect(lines).toContain('onecli agents set-secrets --id oc-family --secret-ids sec-anthropic,sec-mashov');
    expect(lines.some((l) => l.includes('oc-default'))).toBe(false);
    expect(blockedAgentIds()).toEqual(['oc-ag-work']);
    expect(rulesNow()[0].pathPattern).toBe('/mashov/*');

    expect(serversOf('ag-family').mashov).toEqual({ type: 'http', url: 'http://host.docker.internal:8787/mashov/mcp' });
    expect(serversOf('ag-work').mashov).toBeUndefined();
  });

  it('is idempotent: a second run issues no new rule and no new registration', () => {
    expect(apply('ag-family').status).toBe(0);
    fs.writeFileSync(calls, '');
    expect(apply('ag-family').status).toBe(0);
    const lines = callLines();
    expect(lines.some((l) => l.startsWith('onecli rules create'))).toBe(false);
    expect(lines.some((l) => l.startsWith('ncl groups config add-mcp-server'))).toBe(false);
    expect(blockedAgentIds()).toEqual(['oc-ag-work']);
  });

  it('switching the choice unregisters the old group, unblocks the new one and blocks the old one', () => {
    expect(apply('ag-family').status).toBe(0);
    const { status, stdout } = apply('ag-work');
    expect(status).toBe(0);
    expect(stdout).toContain('unregistered: ag-family');
    expect(serversOf('ag-family').mashov).toBeUndefined();
    expect(serversOf('ag-work').mashov).toBeDefined();
    expect(blockedAgentIds()).toEqual(['oc-family']);
  });

  it('`all` opens every group and removes stale block rules', () => {
    reset({ rules: [{ id: 'rule-old', agentId: 'oc-family', name: 'Mashov: blocked for Family' }] });
    const { status } = apply('all');
    expect(status).toBe(0);
    expect(callLines()).toContain('onecli rules delete --id rule-old');
    expect(blockedAgentIds()).toEqual([]);
    expect(serversOf('ag-family').mashov).toBeDefined();
    expect(serversOf('ag-work').mashov).toBeDefined();
  });

  it('`none` blocks and unregisters every group', () => {
    reset({
      servers: { 'ag-family': { mashov: { type: 'http', url: 'http://host.docker.internal:8787/mashov/mcp' } } },
    });
    const { status, stdout } = apply('none');
    expect(status).toBe(0);
    expect(stdout).not.toContain('allowed:');
    expect(blockedAgentIds()).toEqual(['oc-ag-work', 'oc-family']);
    expect(serversOf('ag-family').mashov).toBeUndefined();
    expect(callLines().some((l) => l.startsWith('onecli agents set-secrets'))).toBe(false);
  });

  it('refuses an unknown agent id before touching anything', () => {
    const { status } = apply('ag-typo');
    expect(status).not.toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli') || l.includes('add-mcp-server'))).toBe(false);
  });

  it('never calls set-secrets on an all-mode agent', () => {
    reset({
      agents: [
        { id: 'oc-family', identifier: 'ag-family', name: 'Family', secretMode: 'all' },
        { id: 'oc-work', identifier: 'ag-work', name: 'Work', secretMode: 'all' },
      ],
    });
    expect(apply('ag-family').status).toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli agents set-secrets'))).toBe(false);
  });

  it("leaves the operator's own rules on host.docker.internal alone", () => {
    reset({ rules: [{ id: 'rule-op', agentId: 'oc-family', name: 'ops: no ollama', pathPattern: '/api/*' }] });
    expect(apply('all').status).toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli rules delete'))).toBe(false);
    expect(rulesNow().map((r) => r.id)).toEqual(['rule-op']);
  });

  it('re-enables a disabled block rule', () => {
    reset({ rules: [{ id: 'rule-off', agentId: 'oc-family', name: 'Mashov: blocked for Family', enabled: false }] });
    expect(apply('ag-work').status).toBe(0);
    expect(callLines()).toContain('onecli rules update --id rule-off --enabled true');
    expect(blockedAgentIds()).toEqual(['oc-family']);
  });
});

describe('add-mashov-tool: the bearer token in the OneCLI vault', () => {
  it('replaces the secret through a 0600 temp file that is removed, never argv or stdout', () => {
    const { status, stdout } = sh(CMD.credential);
    expect(status).toBe(0);
    const lines = callLines();
    expect(lines).toContain('onecli secrets delete --id sec-mashov');
    const create = lines.find((l) => l.startsWith('onecli secrets create'));
    expect(create).toMatch(
      /^onecli secrets create --name Mashov MCP --type generic --file \S+ --host-pattern host\.docker\.internal --header-name Authorization --value-format Bearer \{value\}$/,
    );
    expect(fs.readFileSync(path.join(state, 'key-seen'), 'utf8')).toBe(`${TOKEN}\n`);
    expect(fs.readFileSync(path.join(state, 'key-mode'), 'utf8').trim()).toBe('600');
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(stdout).not.toContain(TOKEN);
    const tmp = (create ?? '').match(/--file (\S+)/)?.[1] ?? '';
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('only replaces the secret with its exact name', () => {
    reset({ secrets: [{ id: 'sec-other', name: 'Mashov notes' }] });
    expect(sh(CMD.credential).status).toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli secrets delete'))).toBe(false);
  });

  it('fails without touching the vault when the server has no token', () => {
    reset({ token: false });
    expect(sh(CMD.credential).status).not.toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli secrets'))).toBe(false);
  });
});
