#!/bin/sh
# Planned restart of the :8000 Asymmetric Terminal server. USE THIS instead of pkill / kill for intentional restarts:
# it writes data/restart_planned.json so the supervisor logs the restart as 'planned' (no alert), then SIGTERMs the exact
# supervised PID and waits until the new server answers /api/health. Usage: scripts/restart-server.sh "reason (who/why)"
cd "$(dirname "$0")/.." && exec node scripts/supervisor.js restart "$@"
