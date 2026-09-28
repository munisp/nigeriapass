#!/usr/bin/env bash
# Generate a self-signed TLS cert for the compose postgres (DEV ONLY).
# Production: use real certs (e.g. internal CA) and set POSTGRES_SSL=on.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)/certs"
mkdir -p "$DIR"
openssl req -new -x509 -days 365 -nodes -text \
  -out "$DIR/server.crt" -keyout "$DIR/server.key" \
  -subj "/CN=postgres"
chmod 600 "$DIR/server.key"
# postgres refuses group/world-readable keys; ownership inside container is uid 70
sudo chown 70:70 "$DIR/server.key" 2>/dev/null || chown 70:70 "$DIR/server.key" 2>/dev/null || true
echo "Certs written to $DIR — restart postgres with POSTGRES_SSL=on"
