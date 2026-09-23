#!/usr/bin/env bash
set -euo pipefail
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="backups/who-sabi-me-${STAMP}.tar.gz"
mkdir -p backups

if [[ -f .env.production ]]; then set -a; source .env.production; set +a; fi

# Back up the persistent SQLite data directory from the running container.
docker compose -f docker-compose.production.yml exec -T app sh -lc 'tar -czf - -C /app/data .' > "$OUT"
echo "Created $OUT"
