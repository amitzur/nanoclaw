#!/bin/sh
# Install (or refresh) mashov-mcp as a background service and (re)start it:
# launchd on macOS, a systemd unit on Linux (user unit, or a system unit when
# run as root), nohup as a last resort. Idempotent: re-running rewrites the unit
# and restarts the server. Secrets are never written to the unit; the server
# reads its own 0600 config.
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$DIR/../.." && pwd)
NODE=$(command -v node) || { echo "node not found on PATH" >&2; exit 1; }
CONFIG=${MASHOV_MCP_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/nanoclaw-mashov/config.json}
LOG="$ROOT/logs/mashov-mcp.log"
NAME=nanoclaw-mashov-mcp
LABEL=com.nanoclaw-mashov-mcp
mkdir -p "$ROOT/logs"
[ -f "$DIR/dist/main.js" ] || { echo "build first: (cd $DIR && pnpm install --frozen-lockfile && pnpm run build)" >&2; exit 1; }
"$NODE" "$DIR/dist/setup-cli.js" check --config "$CONFIG" >/dev/null

case "$(uname -s)" in
Darwin)
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$DIR/dist/main.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>MASHOV_MCP_CONFIG</key><string>$CONFIG</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  echo "launchd: $LABEL (re)started; log: $LOG"
  ;;
*)
  if command -v systemctl >/dev/null 2>&1 && { [ "$(id -u)" = 0 ] || systemctl --user show-environment >/dev/null 2>&1; }; then
    if [ "$(id -u)" = 0 ]; then
      UNIT_DIR=/etc/systemd/system; SCTL="systemctl"; TARGET=multi-user.target
    else
      UNIT_DIR="$HOME/.config/systemd/user"; SCTL="systemctl --user"; TARGET=default.target
    fi
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/$NAME.service" <<UNIT
[Unit]
Description=NanoClaw read-only Mashov MCP server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/dist/main.js
Environment=HOME=$HOME
Environment=MASHOV_MCP_CONFIG=$CONFIG
# Binding the docker bridge IP fails until Docker has created docker0; keep retrying.
Restart=always
RestartSec=5
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=$TARGET
UNIT
    $SCTL daemon-reload
    $SCTL enable "$NAME.service" >/dev/null 2>&1
    $SCTL restart "$NAME.service"
    echo "systemd: $NAME.service (re)started; log: $LOG"
  else
    PIDFILE="$DIR/mashov-mcp.pid"
    if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; fi
    MASHOV_MCP_CONFIG="$CONFIG" nohup "$NODE" "$DIR/dist/main.js" >>"$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    echo "no service manager: started with nohup (pid $(cat "$PIDFILE")); it will not survive a reboot. log: $LOG"
  fi
  ;;
esac
