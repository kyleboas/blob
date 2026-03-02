#!/bin/sh
set -eux

echo "[ENTRYPOINT] starting at $(date -Iseconds)" >&2
echo "[ENTRYPOINT] whoami=$(whoami) pwd=$(pwd)" >&2
echo "[ENTRYPOINT] PORT=${PORT:-3000}" >&2

# Restore auth but never block startup
python3 /restore-auth.py || echo "[ENTRYPOINT] restore-auth failed (continuing)" >&2

# Show what's listening before starting
( ss -lntp || true ) >&2

# Start server (PID 1)
exec python3 /server.py