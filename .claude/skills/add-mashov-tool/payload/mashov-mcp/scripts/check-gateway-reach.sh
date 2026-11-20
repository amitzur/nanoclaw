#!/bin/sh
# Verification gate 1: can the OneCLI gateway container reach the server at
# host.docker.internal:<port>? Expects HTTP 401 (reachable; no bearer sent).
# Usage: check-gateway-reach.sh [onecli-container]  (default $ONECLI_GATEWAY_CONTAINER or "onecli")
set -u
DIR=$(cd "$(dirname "$0")/.." && pwd)
C=${1:-${ONECLI_GATEWAY_CONTAINER:-onecli}}
set -- $(node "$DIR/dist/setup-cli.js" endpoint) || exit 1
SCHEME=$1; PORT=$3
URL="$SCHEME://host.docker.internal:$PORT/mashov/health"
docker inspect "$C" >/dev/null 2>&1 || { echo "no container named '$C' (pass the OneCLI container name as the first argument)" >&2; exit 1; }
CODE=$(docker exec "$C" sh -c "
  if command -v curl >/dev/null 2>&1; then curl -sk -o /dev/null -w '%{http_code}' --max-time 5 '$URL';
  elif command -v wget >/dev/null 2>&1; then wget -S --no-check-certificate -T 5 -O /dev/null '$URL' 2>&1 | awk '/HTTP\\//{c=\$2} END{print c}';
  elif command -v node >/dev/null 2>&1; then node -e \"require('$SCHEME').get('$URL',{rejectUnauthorized:false},r=>{console.log(r.statusCode);process.exit(0)}).on('error',()=>{console.log('000');process.exit(0)})\";
  else echo none; fi" 2>/dev/null)
case "$CODE" in
401) echo "ok: $C reaches $URL (401 without a bearer, as expected)" ;;
none) echo "cannot test: '$C' has no curl, wget or node; see docs/mashov.md (gate 1) for a manual check" >&2; exit 1 ;;
*) echo "FAILED: $C got '${CODE:-no response}' from $URL. Add 'extra_hosts: [\"host.docker.internal:host-gateway\"]' to the OneCLI compose service and check the server's bind address and the host firewall (docs/mashov.md)" >&2; exit 1 ;;
esac
