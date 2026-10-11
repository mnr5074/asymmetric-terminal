#!/bin/sh
# Start the server with env from .env (not committed).
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
exec node server.js
