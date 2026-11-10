# Remove Mashov Tool

Reverses `/add-mashov-tool`. Every step is idempotent. It is safe to re-run, and
safe when the tool is only partly installed: skip any step whose target is
already gone. Run it from the NanoClaw repo on the host.

## 1. Unregister the MCP server from every group

```bash
ncl groups list --json | jq -r '.data[].id' | while read -r gid; do ncl groups config get --id "$gid" --json | jq -e '.data.mcp_servers.mashov' >/dev/null && ncl groups config remove-mcp-server --id "$gid" --name mashov; done
```

Each removal may show `approval-pending` until an admin approves it.

## 2. Remove the OneCLI secret and the block rules

Deleting the `Mashov MCP` secret revokes the token for every agent. Per-agent
secret lists are not edited: `set-secrets` would switch an `all`-mode agent to
`selective` and cut it off from its other secrets. Only rules named
`Mashov: blocked for …` are removed. The operator's own rules on
`host.docker.internal` stay:

```bash
for id in $(onecli secrets list | jq -r '.data[] | select(.name=="Mashov MCP") | .id'); do onecli secrets delete --id "$id"; done
for id in $(onecli rules list | jq -r '.data[] | select(.hostPattern=="host.docker.internal" and .action=="block" and (.name | startswith("Mashov: blocked for "))) | .id'); do onecli rules delete --id "$id"; done
```

## 3. Stop and remove the service

This removes the launchd plist or systemd unit, or stops the `nohup` process:

```bash
[ -f tools/mashov-mcp/scripts/uninstall-service.sh ] && sh tools/mashov-mcp/scripts/uninstall-service.sh
```

## 4. Delete the server, its config and its log

The config file holds the Mashov login and the bearer token. It lives outside
the repo, at `$MASHOV_MCP_CONFIG` or `~/.config/nanoclaw-mashov/config.json`:

```bash
rm -rf tools/mashov-mcp
rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/nanoclaw-mashov"
rm -f logs/mashov-mcp.log
```

## 5. Restart the agents

Restart every group so the agents respawn without the MCP server. Each comes
back on its next message:

```bash
ncl groups list --json | jq -r '.data[].id' | while read -r gid; do ncl groups restart --id "$gid"; done
```
