#!/bin/sh
# Start the supervisor detached; no-op if one is already alive for this checkout. It hands ITS environment to the server, so run it
# from a shell that has XAI_API_KEY / X_BEARER_TOKEN / NANSEN_API_KEY (they are NOT in .env). Safe to call repeatedly (e.g. after a reboot).
cd "$(dirname "$0")/.."
if node -e 'const s=require("./data/supervisor.json");process.kill(s.pid,0);if(!require("fs").readFileSync("/proc/"+s.pid+"/cmdline","utf8").includes("supervisor.js"))process.exit(1)' 2>/dev/null; then
  echo "supervisor already running (node scripts/supervisor.js status)"; exit 0; fi
for v in XAI_API_KEY X_BEARER_TOKEN NANSEN_API_KEY; do eval "test -n \"\${$v}\"" || echo "warning: $v not set in this environment: server will start without it" >&2; done
nohup setsid node scripts/supervisor.js >> data/supervisor.log 2>&1 < /dev/null &
echo "supervisor launched (pid $!)"
