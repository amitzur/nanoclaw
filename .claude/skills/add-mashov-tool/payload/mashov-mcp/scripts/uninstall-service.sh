#!/bin/sh
# Stop mashov-mcp and remove its service definition. Idempotent.
set -u
DIR=$(cd "$(dirname "$0")/.." && pwd)
NAME=nanoclaw-mashov-mcp
LABEL=com.nanoclaw-mashov-mcp
case "$(uname -s)" in
Darwin)
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  [ -f "$PLIST" ] && launchctl unload "$PLIST" 2>/dev/null
  rm -f "$PLIST"
  ;;
*)
  if command -v systemctl >/dev/null 2>&1; then
    for SCOPE in "--user" ""; do
      if [ -z "$SCOPE" ] && [ "$(id -u)" != 0 ]; then continue; fi
      systemctl $SCOPE disable --now "$NAME.service" >/dev/null 2>&1 || true
    done
    rm -f "$HOME/.config/systemd/user/$NAME.service"
    [ "$(id -u)" = 0 ] && rm -f "/etc/systemd/system/$NAME.service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    [ "$(id -u)" = 0 ] && systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  ;;
esac
if [ -f "$DIR/mashov-mcp.pid" ]; then kill "$(cat "$DIR/mashov-mcp.pid")" 2>/dev/null || true; rm -f "$DIR/mashov-mcp.pid"; fi
echo "mashov-mcp service removed"
