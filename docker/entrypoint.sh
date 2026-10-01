#!/bin/sh
# Container entrypoint: the Next app plus the MCP server.
#
# The MCP server has to run as its own process so it keeps serving while no
# browser tab is open, and so a crash in one cannot take the other down. It is
# started first and torn down whenever the app exits, so `docker stop` does not
# leave a stray listener holding port 3738.
set -eu

if [ ! -f /app/packages/mcp/dist/server.js ]; then
  echo "[entrypoint] MCP server bundle missing; starting the app only." >&2
  exec node apps/web/server.js
fi

node packages/mcp/bin/llm-wiki-mcp.mjs &
MCP_PID=$!

shutdown() {
  kill "$MCP_PID" 2>/dev/null || true
  wait "$MCP_PID" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

node apps/web/server.js &
APP_PID=$!
wait "$APP_PID"
