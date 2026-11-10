# Mashov (read-only) for agents

`/add-mashov-tool` installs **mashov-mcp**, a small host-side MCP server that gives chosen agent groups read-only access to a Mashov parent account. It requires no NanoClaw core changes.

```
agent ──HTTP(S)_PROXY──▶ OneCLI gateway ──(injects "Authorization: Bearer …")──▶ host: mashov-mcp :8787/mashov/mcp ──▶ web.mashov.info
```

- The Mashov username and password stay on the host, in `~/.config/nanoclaw-mashov/config.json` (mode `0600`, or `$XDG_CONFIG_HOME/nanoclaw-mashov/config.json`, or `$MASHOV_MCP_CONFIG`). They are never put on argv, in logs, in tool output, or in any `container.json`.
- The server generates a random bearer token and keeps it in the same file. A copy goes into the OneCLI vault as the secret **"Mashov MCP"** (host pattern `host.docker.internal`, header `Authorization`, format `Bearer {value}`). Agents never see the token. OneCLI adds it to their requests.
- Every request without the right bearer is rejected with `401`.
- Groups you did not choose have no MCP registration. They also get a OneCLI block rule (`Mashov: blocked for <group>`, path `/mashov/*`), so a `curl` to the port returns `403`.
- After login the server only sends `GET` requests to Mashov. It never opens mail, because opening a message marks it read; it reports at most an unread count. It caches nothing on disk, keeping only its session cookie in memory. Logs never contain child names or ids.

## Tools

| Tool | What it returns |
| --- | --- |
| `mashov_children` | children on the account (first name, class) |
| `mashov_homework(child?, from?, to?)` | homework per lesson (default: last 7 days through next 14) |
| `mashov_grades(child?, since?)` | grades this school year, newest first |
| `mashov_timetable(child?)` | weekly timetable |
| `mashov_behavior(child?, from?, to?)` | attendance and behavior events (default: last 30 days) |
| `mashov_notices(child?)` | message-board notices and the unread mail count |
| `mashov_holidays` | upcoming school holidays |

`child` is a first name (or the first name plus class as `mashov_children` shows it, when two children share a name). Leave it out, or pass `all`, to cover every child.

## Setup

Run these steps on the host, from the NanoClaw checkout.

1. **Find the school's semel.** Open https://web.mashov.info/api/schools in a browser. It returns a JSON list of schools (`semel`, `name`, and more). Search it for the school's name; the semel is a number of about 6 digits.
2. **Run `/add-mashov-tool`** in Claude Code. It asks which agent groups get access (`all`, `none`, or a comma-separated list of `ag-…` ids), then builds the server in `tools/mashov-mcp` and runs its tests.
3. **Enter the credentials** when the skill asks. Use either method:
   - Interactive, with a hidden password prompt: `node tools/mashov-mcp/dist/setup-cli.js configure`
   - From a file:
     ```bash
     F=$(mktemp) && chmod 600 "$F" && ${EDITOR:-vi} "$F"   # semel=… username=… password=… (year=… optional)
     node tools/mashov-mcp/dist/setup-cli.js configure --from-file "$F"; rm -f "$F"
     ```
   Options: `--bind IP`, `--port N` (default `8787`), `--rotate-token`. To test the login against Mashov, run `node tools/mashov-mcp/dist/setup-cli.js check --login`.
4. **Let the skill finish.** It installs the service (launchd on macOS, a systemd user unit on Linux, `nohup` otherwise), runs the gate 1 reachability check, stores the token in OneCLI, writes the allow and block rules, registers `mashov` on the chosen groups, and restarts them. Approve any `ncl` approval cards it raises.
5. **Check gates 2 and 3 from a chat**, as the skill's last step describes.

Re-running `/add-mashov-tool` is safe, because every step is idempotent. Re-run it to change which groups have access, after `--rotate-token`, or after switching to TLS.

### Bind address

| Host | Default bind | Why |
| --- | --- | --- |
| Linux | `172.17.0.1` (docker0) | `host.docker.internal:host-gateway` resolves to the docker bridge IP. Binding there keeps the port off the LAN, VPN and public interfaces. |
| macOS | `127.0.0.1` | Docker Desktop forwards `host.docker.internal` to the host loopback. |

`0.0.0.0` is never the default. It would expose the server, and with it the child's school data, to every network the host is on, protected only by the bearer token.

If your docker bridge uses another IP (check with `ip -4 addr show docker0`), or OneCLI runs on a custom network, re-run `configure --bind <that gateway IP>` and then re-run the skill.

## Verification gates

1. **OneCLI reaches the host.** `tools/mashov-mcp/scripts/check-gateway-reach.sh` makes a request from inside the OneCLI container to `http://host.docker.internal:<port>/mashov/health` and expects `401`.
2. **Header injection.** A chosen agent runs `curl -s -o /dev/null -w '%{http_code}' http://host.docker.internal:8787/mashov/health`. `200` means OneCLI injected the token.
3. **Smoke test.** Ask a chosen agent "who are my kids in Mashov?"; it should call `mashov_children`. A group you did not choose should get `403` from the same `curl`.
4. **No leak into containers.** After gate 3, run this from the NanoClaw repo on the host. It searches the agent workspaces, session databases and the running containers for Mashov cookie or CSRF names and for the configured password. It must print nothing:

   ```bash
   PW_FILE=$(mktemp) && node -e 'const c=require(require("os").homedir()+"/.config/nanoclaw-mashov/config.json");process.stdout.write(c.password+"\n"+c.username+"\n")' > "$PW_FILE"
   grep -rlaE 'MashovSessionID|Csrf-Token|x-csrf-token' groups data 2>/dev/null
   grep -rlaF -f "$PW_FILE" groups data 2>/dev/null
   for c in $(docker ps --format '{{.Names}}' | grep -i nanoclaw); do
     docker exec "$c" sh -c 'env; grep -rlaE "MashovSessionID|Csrf-Token|x-csrf-token" /workspace /home 2>/dev/null' | grep -iE 'mashov|csrf' && echo "LEAK in $c"
   done
   rm -f "$PW_FILE"
   ```

   The automated counterpart is `test/no-leak.test.ts`. It checks the raw HTTP response (every header and the full body) and the host log for every tool, on success and on every upstream failure: 5xx, invalid JSON, 403/404, redirects, login rejection, network errors, re-login, and secrets planted in data rows.

## Troubleshooting

### Gate 1 fails: OneCLI cannot reach the server

- Add `extra_hosts: ["host.docker.internal:host-gateway"]` to the OneCLI service in its compose file, then recreate the container.
- Make sure the server listens on the docker bridge IP (see Bind address) with `ss -ltnp | grep 8787`.
- On Linux, firewalls such as UFW often drop traffic from `docker0` to the host. Allow it, for example `sudo ufw allow in on docker0 to any port 8787 proto tcp`.
- The log is at `logs/mashov-mcp.log`. A `cannot read tlsCertFile/tlsKeyFile` error or a config error stops the server from starting.

### A chosen agent gets 401

This means the request reached the server but OneCLI did not inject the header. Some gateway versions only inject on intercepted HTTPS, not on plain-http forwarded requests. Work through these in order:

1. Check that the secret exists (`onecli secrets list`) with host pattern `host.docker.internal`. Also check that the agent has it: either the agent is in "all secrets" mode, or "Mashov MCP" is in its selected secrets. Re-run the skill to repair it.
2. If plain-http injection is still missing, use the **TLS fallback**. The server serves HTTPS, and OneCLI intercepts it and injects the header the same way it does for other HTTPS APIs:
   ```bash
   D=~/.config/nanoclaw-mashov && openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
     -subj "/CN=host.docker.internal" -addext "subjectAltName=DNS:host.docker.internal" \
     -keyout "$D/tls.key" -out "$D/tls.crt" && chmod 600 "$D/tls.key"
   ```
   Add `"tlsCertFile": "<D>/tls.crt", "tlsKeyFile": "<D>/tls.key"` to `config.json`. Both are required. Then restart the service with `sh tools/mashov-mcp/scripts/install-service.sh` and re-run `/add-mashov-tool`. The endpoint capture switches the registered URL to `https://host.docker.internal:<port>/mashov/mcp`.

   OneCLI has to trust this self-signed upstream certificate. If the gateway rejects it, add the cert to OneCLI's upstream CA trust; see your OneCLI version's docs for custom upstream CAs.

### An agent gets 403

The OneCLI block rule matched, meaning this group was not chosen. If it should have access, re-run `/add-mashov-tool` and include it. If a chosen group gets `403`, look for a manual block rule of your own on `host.docker.internal` with `onecli rules list`. The skill only manages rules whose names start with `Mashov: blocked for `.

### Tools say "Mashov rejected the login"

The username, password, semel or year is wrong. Run `configure` again, then `check --login`. After an auth failure the server waits **15 minutes** before trying again, to avoid locking the account. Restart the service to retry sooner.

### "Mashov requires a password change"

Log in once at https://web.mashov.info, change the password, then run `configure` with the new one.

### Grades or homework look empty after September 1st

When `year` is not pinned, the server switches to the new school year on September 1st (Mashov names a school year after the calendar year it ends in). If the school opens the new year late in Mashov, pin the year with `year=<YYYY>` in the credentials file and run `configure --from-file` again.

### Egress lockdown

Under `--internal` networks, `host.docker.internal` inside agent containers already points at the OneCLI gateway, so the gateway route above is the only route. It works the same way.

### Caveats

- Mashov's web API is unofficial and undocumented, so it may change without notice. If tools start failing with `Mashov returned HTTP …`, check the log and open an issue.
- Tool output becomes part of the agent's conversation transcript, the same as any tool result. Nothing else stores it.

## Removing

See [`.claude/skills/add-mashov-tool/REMOVE.md`](../.claude/skills/add-mashov-tool/REMOVE.md).
