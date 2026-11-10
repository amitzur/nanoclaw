---
name: add-mashov-tool
description: Give chosen NanoClaw agents read-only access to Mashov (the Israeli school portal) through a small host-side MCP server. The server holds the parent's Mashov login on the host, the bearer token that protects it lives only in the OneCLI vault, and agents you leave out are blocked at the gateway. Tools cover children, homework, grades, timetable, behavior events, notices and holidays. Mail bodies are never read. Idempotent; re-run it to change which agents may use Mashov. Use when the user wants an agent to answer questions about their kids' school data from Mashov.
---

# Add Mashov Tool

Installs `mashov-mcp`, a read-only Streamable-HTTP MCP server that runs on the
host as its own service, and gives the agents you choose an MCP connection to it.

```
agent ──HTTP(S)_PROXY──▶ OneCLI gateway ──(injects Bearer, per agent)──▶ host: mashov-mcp /mashov/mcp ──▶ web.mashov.info
```

How the pieces fit:

- **The Mashov login stays on the host.** The server keeps its own config file
  at `~/.config/nanoclaw-mashov/config.json` (mode `0600`). It holds the school
  semel, the parent username and password, and the server's bearer token. The
  operator types the credentials, either at a hidden prompt or into a `0600`
  temp file that is deleted after it is read. They never go on a command line,
  into a log, into tool output, or into `container.json`.
- **The bearer token stays out of the container.** The server rejects any
  request without `Authorization: Bearer <token>`. The token is stored in the
  OneCLI vault for `host.docker.internal`, and OneCLI adds the header to each
  agent request. The group's MCP registration holds only the URL, so the agent
  never sees the token.
- **Access is per agent.** Each agent group you leave out gets an OneCLI block
  rule on `host.docker.internal` path `/mashov/*`, so it sees
  `403 blocked_by_policy`. Chosen groups get an `mashov` MCP server entry. The
  other groups get none.
- **The server only reads.** After login it sends only `GET` requests to
  Mashov. It returns compact, whitelisted fields, never mail bodies (opening
  one marks it read), and only an unread count for mail. Student data is never
  written to disk. Its log lines carry only the tool name, status and duration,
  never child names or ids.

Tools: `mashov_children`, `mashov_homework(child?, from?, to?)`,
`mashov_grades(child?, since?)`, `mashov_timetable(child?)`,
`mashov_behavior(child?, from?, to?)`, `mashov_notices(child?)` (includes the
unread mail count), and `mashov_holidays(include_past?)`. `child` takes a first
name such as "Noa" or "Noa Cohen". Leave it out or pass `all` to get every
child.

Run this from the NanoClaw repo on the host, not from a chat with an agent. The
container can't install a host service. Every step is idempotent, so the whole
skill is safe to re-run. Setup, finding the school semel, and troubleshooting are
covered in [docs/mashov.md](../../../docs/mashov.md).

There is no in-tree registration test for this skill. Its only integration with
NanoClaw is runtime state: an `ncl` MCP server registration plus OneCLI vault
entries and rules. No source line exists for a test to guard. Two things stand in
for one. The server's own typecheck and test suite run before anything is
started, and they guard its pinned dependencies. `scripts/add-mashov-tool-scope.test.ts`
runs this document's scoping and credential commands against stub `ncl` and
`onecli` binaries.

## Pre-flight

OneCLI is required. It is the only way to hand the bearer token to a container
without putting it in the container's config. The host also needs Node, pnpm,
jq, and Docker for the reachability check:

```nc:run effect:check
for c in onecli node pnpm jq docker; do command -v "$c" >/dev/null || { echo "missing on the host: $c" >&2; exit 1; }; done
```

If `onecli` is missing, run `/init-onecli` first, then retry. Stop here.

The block rules are scoped to the server's path so other services the host
exposes on `host.docker.internal` are not affected. That needs OneCLI rule path
patterns:

```nc:run effect:check
onecli rules create --help 2>&1 | grep -q -- '--path-pattern' || { echo "this OneCLI has no rule path patterns (--path-pattern); upgrade OneCLI, then re-run" >&2; exit 1; }
```

## Choose which agents may use Mashov

List the agent groups. The NanoClaw service must be running, because `ncl`
talks to it over its socket:

```nc:run capture:agent_groups effect:fetch
ncl groups list --json | jq -r 'if (.data|length)==0 then "no agent groups yet" else [.data[] | "\(.id) (\(.name))"] | join(", ") end'
```

Ask the operator which of them may use Mashov. Say plainly what they are
granting, and ask even when there is only one agent:

```nc:operator
Agents on this install: {{agent_groups}}. An agent with Mashov can read your children's school data: names, classes, grades, homework, behavior events, timetable and notices. Anything it reads becomes part of that agent's conversation. Agents you leave out are blocked at the gateway; run /add-mashov-tool again to change the choice. Agents created after this run are not blocked until the next run, but they get no Mashov MCP server either.
```
```nc:prompt mashov_agents validate:^(all|none|ag-[A-Za-z0-9-]+(,ag-[A-Za-z0-9-]+)*)$ normalize:trim
Which agents may use Mashov? Enter agent ids separated by commas with no spaces (the `ag-…` column), `all` for every agent, or `none` to install the server with every agent blocked for now.
```

`all` and `none` can't be combined with ids, and an empty answer never means
everyone. A typo must not silently grant or block access, so every id must name
a real agent group:

```nc:run effect:check
for w in $(printf '%s' '{{mashov_agents}}' | tr ',' ' '); do case "$w" in all|none) ;; *) ncl groups list --json | jq -e --arg id "$w" '.data[] | select(.id==$id)' >/dev/null || { echo "unknown agent group '$w' — see: ncl groups list" >&2; exit 1; }; esac; done
```

## Install the server

Copy the server into `tools/mashov-mcp/`. It is a standalone package with its
own lockfile and pinned dependencies, and the NanoClaw build does not touch it:

```nc:copy
payload/mashov-mcp/.gitignore -> tools/mashov-mcp/.gitignore
payload/mashov-mcp/package.json -> tools/mashov-mcp/package.json
payload/mashov-mcp/pnpm-lock.yaml -> tools/mashov-mcp/pnpm-lock.yaml
payload/mashov-mcp/pnpm-workspace.yaml -> tools/mashov-mcp/pnpm-workspace.yaml
payload/mashov-mcp/tsconfig.json -> tools/mashov-mcp/tsconfig.json
payload/mashov-mcp/tsconfig.test.json -> tools/mashov-mcp/tsconfig.test.json
payload/mashov-mcp/vitest.config.ts -> tools/mashov-mcp/vitest.config.ts
payload/mashov-mcp/src/config.ts -> tools/mashov-mcp/src/config.ts
payload/mashov-mcp/src/http.ts -> tools/mashov-mcp/src/http.ts
payload/mashov-mcp/src/log.ts -> tools/mashov-mcp/src/log.ts
payload/mashov-mcp/src/main.ts -> tools/mashov-mcp/src/main.ts
payload/mashov-mcp/src/mashov-client.ts -> tools/mashov-mcp/src/mashov-client.ts
payload/mashov-mcp/src/normalize.ts -> tools/mashov-mcp/src/normalize.ts
payload/mashov-mcp/src/setup-cli.ts -> tools/mashov-mcp/src/setup-cli.ts
payload/mashov-mcp/src/tools.ts -> tools/mashov-mcp/src/tools.ts
payload/mashov-mcp/test/config.test.ts -> tools/mashov-mcp/test/config.test.ts
payload/mashov-mcp/test/fake-mashov.ts -> tools/mashov-mcp/test/fake-mashov.ts
payload/mashov-mcp/test/http.test.ts -> tools/mashov-mcp/test/http.test.ts
payload/mashov-mcp/test/mashov-client.test.ts -> tools/mashov-mcp/test/mashov-client.test.ts
payload/mashov-mcp/test/normalize.test.ts -> tools/mashov-mcp/test/normalize.test.ts
payload/mashov-mcp/scripts/check-gateway-reach.sh -> tools/mashov-mcp/scripts/check-gateway-reach.sh
payload/mashov-mcp/scripts/install-service.sh -> tools/mashov-mcp/scripts/install-service.sh
payload/mashov-mcp/scripts/uninstall-service.sh -> tools/mashov-mcp/scripts/uninstall-service.sh
```

Install its dependencies and build it:

```nc:run effect:build
cd tools/mashov-mcp && pnpm install --frozen-lockfile && pnpm run build
```

Typecheck it and run its tests. The tests use a synthetic Mashov fake and make
no network calls. They cover login, re-login, the GET-only rule, bearer
enforcement, child-name matching, and checks that no cookies, CSRF tokens,
credentials, ids, or mail bodies reach the agent, including on every upstream
error path (`test/no-leak.test.ts`):

```nc:run effect:test
cd tools/mashov-mcp && pnpm run typecheck && pnpm test
```

## Enter the Mashov login

The operator enters the login on the host. Keep it out of this chat. You need the
school **semel**, a six-digit school code. To find it, open
https://web.mashov.info/api/schools in a browser and search for the school's
name. The page lists each school's `semel`, name and city. See
[docs/mashov.md](../../../docs/mashov.md).

```nc:operator
In a terminal on this host, from the NanoClaw repo, run:

  node tools/mashov-mcp/dist/setup-cli.js configure

It prompts for the school semel, the Mashov parent username and the password (hidden), and generates the server's bearer token. Non-interactive alternative: write a temp file with `T=$(mktemp) && chmod 600 "$T"`, put lines `semel=…`, `username=…`, `password=…` in it with an editor, then run `node tools/mashov-mcp/dist/setup-cli.js configure --from-file "$T"`. The file must be mode 0600, and it is deleted after it is read.

The server listens on 172.17.0.1 (the Docker bridge) on Linux and 127.0.0.1 on macOS, port 8787. If your docker0 address differs (`ip -4 addr show docker0`), add `--bind <that-ip>`; `--port <n>` changes the port. Re-running configure keeps the existing token; add `--rotate-token` to replace it. Optional: `node tools/mashov-mcp/dist/setup-cli.js check --login` logs in once and prints only the number of children.
```

Confirm the config is present, private, and complete. This prints a summary with
no secrets:

```nc:run effect:check
node tools/mashov-mcp/dist/setup-cli.js check
```

## Start the service

Install the server as a background service: launchd on macOS, or a systemd unit
on Linux (a user unit, or a system unit when run as root). It falls back to
`nohup` when neither is available. The unit holds no secrets, because the server
reads its own `0600` config. Re-running rewrites the unit and restarts the
server:

```nc:run effect:restart
sh tools/mashov-mcp/scripts/install-service.sh
```

Logs go to `logs/mashov-mcp.log`.

## Check the gateway can reach the server

The OneCLI gateway forwards agent requests to `host.docker.internal:<port>`, so
it must be able to reach the server from its own container. This step runs a
probe from inside the OneCLI container. The probe expects `401`: the server is
reachable and answers, but the probe sends no token. Set
`ONECLI_GATEWAY_CONTAINER` if the gateway container is not named `onecli`.

```nc:run effect:check
sh tools/mashov-mcp/scripts/check-gateway-reach.sh
```

If it fails, the gateway container needs the `host.docker.internal` alias.
Add `extra_hosts: ["host.docker.internal:host-gateway"]` to the OneCLI compose
service and recreate the container. Also check the bind address and that the
host firewall allows Docker bridge traffic to the port. Then re-run this skill.

## Put the bearer token in the OneCLI vault

Store the server's token as an OneCLI secret named `Mashov MCP` for
`host.docker.internal`, injected as `Authorization: Bearer <token>`. Any existing
secret with that name is deleted and a new one created, so a rotated token always
lands. `onecli secrets update` only takes a new value on the command line, and
the token must never go on one. It travels through a `0600` temp file, removed
right after, so it never appears in argv or a captured variable:

```nc:run effect:external
T=$(mktemp) && chmod 600 "$T" && node tools/mashov-mcp/dist/setup-cli.js print-token > "$T" 2>/dev/null; [ -s "$T" ] || { rm -f "$T"; echo "could not read the server token — run setup-cli.js configure first" >&2; exit 1; }; S=$(onecli secrets list | jq -r 'first(.data[] | select(.name=="Mashov MCP")) | .id // empty'); if [ -n "$S" ]; then onecli secrets delete --id "$S" >/dev/null || { rm -f "$T"; echo "could not remove the previous Mashov MCP secret $S" >&2; exit 1; }; fi; onecli secrets create --name "Mashov MCP" --type generic --file "$T" --host-pattern host.docker.internal --header-name Authorization --value-format "Bearer {value}" >/dev/null; rc=$?; rm -f "$T"; exit $rc
```

## Scope it to the chosen agents

### Create the OneCLI agents

Every agent group has its own OneCLI agent, whose `identifier` is the group id.
The runtime creates it the first time the group spawns. A block rule needs an
agent to attach to, so create any that are missing now, the same way the runtime
does (secret mode `all`, nothing else changed):

```nc:run effect:wire
G=$(ncl groups list --json) || { echo "could not list agent groups — is the NanoClaw host running?" >&2; exit 1; }; AG=$(onecli agents list) || { echo "could not list OneCLI agents" >&2; exit 1; }; printf '%s' "$G" | jq -r '.data[] | "\(.id)\t\(.name)"' | while IFS="$(printf '\t')" read -r gid gname; do printf '%s' "$AG" | jq -e --arg g "$gid" '.data[] | select(.identifier==$g)' >/dev/null || onecli agents create --name "$gname" --identifier "$gid" >/dev/null || { echo "could not create an OneCLI agent for $gname ($gid)" >&2; exit 1; }; done
```

### Set the block rules

Access is controlled by a per-agent **block rule** on `host.docker.internal`
path `/mashov/*`. These rules are named `Mashov: blocked for <group>`, and only
rules with that name are ever read or changed. The operator's own rules stay
untouched. A chosen agent has its rule removed. Every other agent has one
present and enabled. In a container, `403 blocked_by_policy` means "not
chosen", not "broken":

```nc:run effect:wire
A=$(printf '%s' '{{mashov_agents}}' | tr -d ' '); G=$(ncl groups list --json) || { echo "could not list agent groups — is the NanoClaw host running?" >&2; exit 1; }; case ",$A," in *,all,*) A=$(printf '%s' "$G" | jq -r '[.data[].id] | join(",")');; esac; AG=$(onecli agents list) || { echo "could not list OneCLI agents" >&2; exit 1; }; RL=$(onecli rules list) || { echo "could not list OneCLI rules" >&2; exit 1; }; printf '%s' "$G" | jq -r '.data[] | "\(.id)\t\(.name)"' | while IFS="$(printf '\t')" read -r gid gname; do aid=$(printf '%s' "$AG" | jq -r --arg g "$gid" 'first(.data[] | select(.identifier==$g)) | .id // empty'); [ -n "$aid" ] || { echo "no OneCLI agent for $gname ($gid)" >&2; exit 1; }; rid=$(printf '%s' "$RL" | jq -r --arg a "$aid" 'first(.data[] | select(.hostPattern=="host.docker.internal" and .action=="block" and .agentId==$a and (.name | startswith("Mashov: blocked for ")))) | .id // empty'); case ",$A," in *,"$gid",*) if [ -n "$rid" ]; then onecli rules delete --id "$rid" >/dev/null || { echo "could not remove the Mashov block for $gname ($gid)" >&2; exit 1; }; fi; echo "allowed: $gname ($gid)";; *) if [ -z "$rid" ]; then onecli rules create --name "Mashov: blocked for $gname" --host-pattern host.docker.internal --path-pattern '/mashov/*' --action block --agent-id "$aid" --enabled >/dev/null || { echo "could not create the Mashov block for $gname ($gid)" >&2; exit 1; }; else onecli rules update --id "$rid" --enabled true >/dev/null || { echo "could not re-enable the Mashov block for $gname ($gid)" >&2; exit 1; }; fi; echo "blocked: $gname ($gid)";; esac; done
```

### Merge secrets for selective agents

Secret lists stay as they are, with one exception. An agent in `selective` mode
gets only the secrets on its list, so a **chosen** selective agent has the
Mashov MCP secret merged into its list. `onecli agents set-secrets` switches an
agent to selective mode, so it is never called on an `all`-mode agent. Doing that
would silently cut the agent off from every credential not on its list. Blocked
agents keep their lists unchanged in either mode, and the rule alone blocks
them:

```nc:run effect:wire
A=$(printf '%s' '{{mashov_agents}}' | tr -d ' '); case ",$A," in *,all,*) A=$(ncl groups list --json | jq -r '[.data[].id] | join(",")');; esac; S=$(onecli secrets list | jq -r 'first(.data[] | select(.name=="Mashov MCP")) | .id // empty'); [ -n "$S" ] || { echo "no Mashov MCP secret in the OneCLI vault — the vault step above did not complete" >&2; exit 1; }; onecli agents list | jq -r '.data[] | select(.secretMode=="selective") | "\(.id)\t\(.identifier)"' | while IFS="$(printf '\t')" read -r aid gid; do case ",$A," in *,"$gid",*) onecli agents set-secrets --id "$aid" --secret-ids "$(onecli agents secrets --id "$aid" | jq -r --arg s "$S" '[.data[], $s] | unique | join(",")')" >/dev/null || { echo "could not add the Mashov MCP secret to $gid" >&2; exit 1; }; echo "Mashov MCP secret added to the list of $gid";; esac; done
```

### Register the MCP server

Agents reach the server at `host.docker.internal` on the configured port, path
`/mashov/mcp`, over the scheme the server serves:

```nc:run capture:mashov_url validate:^https?://host\.docker\.internal:[0-9]+/mashov/mcp$ effect:fetch
set -- $(node tools/mashov-mcp/dist/setup-cli.js endpoint) && echo "$1://host.docker.internal:$3/mashov/mcp"
```

The same server answers a health check at `/mashov/health`, which the verification below uses:

```nc:run capture:mashov_health_url validate:^https?://host\.docker\.internal:[0-9]+/mashov/health$ effect:fetch
set -- $(node tools/mashov-mcp/dist/setup-cli.js endpoint) && echo "$1://host.docker.internal:$3/mashov/health"
```

Register `mashov` on each chosen group, and remove it from any other group that
has it. An entry that already has this URL is left alone. Each change may show
`approval-pending` until an admin approves it, and that is not an error:

```nc:run effect:wire
A=$(printf '%s' '{{mashov_agents}}' | tr -d ' '); G=$(ncl groups list --json) || { echo "could not list agent groups — is the NanoClaw host running?" >&2; exit 1; }; case ",$A," in *,all,*) A=$(printf '%s' "$G" | jq -r '[.data[].id] | join(",")');; esac; printf '%s' "$G" | jq -r '.data[].id' | while read -r gid; do C=$(ncl groups config get --id "$gid" --json) || { echo "could not read the config of $gid" >&2; exit 1; }; case ",$A," in *,"$gid",*) if printf '%s' "$C" | jq -e --arg u '{{mashov_url}}' '.data.mcp_servers.mashov.url==$u' >/dev/null; then echo "registered: $gid"; else ncl groups config add-mcp-server --id "$gid" --name mashov --url '{{mashov_url}}' >/dev/null || { echo "could not register the Mashov MCP server on $gid" >&2; exit 1; }; echo "registered: $gid"; fi;; *) if printf '%s' "$C" | jq -e '.data.mcp_servers.mashov' >/dev/null; then ncl groups config remove-mcp-server --id "$gid" --name mashov >/dev/null || { echo "could not remove the Mashov MCP server from $gid" >&2; exit 1; }; echo "unregistered: $gid"; fi;; esac; done
```

## Hand the tool to running agents

MCP server changes take effect when a group's container respawns. Restart every
group. Each one comes back on its next message with its new MCP set:

```nc:run effect:restart
ncl groups list --json | jq -r '.data[].id' | while read -r gid; do ncl groups restart --id "$gid" >/dev/null || { echo "could not restart $gid" >&2; exit 1; }; done
```

## Verify from a chat

Two checks can only run from inside an agent container:

```nc:operator
1. Header injection. In a chat with a CHOSEN agent, ask it to run: curl -s -o /dev/null -w '%{http_code}' {{mashov_health_url}} — then: 200 means OneCLI injected the token. 401 means the request reached the server without the token: see "A chosen agent gets 401" in docs/mashov.md (TLS fallback). 403 means this agent is blocked: re-run /add-mashov-tool.
2. Data and blocking. Ask the chosen agent "which kids do you see in Mashov?" (it calls mashov_children). Then ask a NON-chosen agent to run the same curl; it must get 403.
```

## Done

The chosen agents now have the `mashov` MCP tools, and every other agent is
blocked at the gateway. To change who has access, re-run `/add-mashov-tool`. To
replace the Mashov login, run `node tools/mashov-mcp/dist/setup-cli.js configure`
again, then `sh tools/mashov-mcp/scripts/install-service.sh`. To rotate the
bearer token, add `--rotate-token` to `configure`, then re-run this skill so the
vault gets the new token.

To uninstall, see [REMOVE.md](REMOVE.md).

## Troubleshooting

**A pre-flight check fails.** Install whatever is missing. For OneCLI, run
`/init-onecli`. If OneCLI has no `--path-pattern`, upgrade it.

**`unknown agent group`.** An id in your answer is not in `ncl groups list`.
Copy the `ag-…` id exactly. Names are not accepted.

**`setup-cli.js check` fails.** Read the message:

- "chmod 600" means the config file is readable by other users.
- A missing field means `configure` did not finish.

Run `configure` again.

**The gateway reach check fails.** Add `extra_hosts:
["host.docker.internal:host-gateway"]` to the OneCLI compose service. Check that
the bind address matches the docker0 IP (`ip -4 addr show docker0`), and that
the firewall (UFW, firewalld) allows Docker bridge traffic to the port.

**A chosen agent gets `401`.** Either the token in the vault is stale (re-run
this skill), or OneCLI did not inject the header on a plain-HTTP request.
For the second case, serve TLS instead; see the TLS fallback in
[docs/mashov.md](../../../docs/mashov.md).

**A chosen agent gets `403`.** Its block rule is still in place. Re-run this
skill and pick it.

**A tool returns "Mashov rejected the login".** The password is wrong or has
changed. Run `configure` again and restart the service. After a rejected login,
the server waits 15 minutes before retrying, so the account is not locked by
repeated attempts.

**"Mashov requires a password change".** Log in at https://web.mashov.info
once in a browser, set a new password, then run `configure` again.

**An agent you left out has no block rule.** It was created after the last run.
Re-run this skill.
