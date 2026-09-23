#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env.production ]]; then
  echo "Missing .env.production. Copy .env.production.example and fill production values."
  exit 1
fi

if grep -Eq 'REPLACE_ME|YOUR-DOMAIN|sk_live_REPLACE' .env.production; then
  echo "Production environment still contains placeholder values."
  exit 1
fi

docker compose -f docker-compose.production.yml config >/dev/null
docker compose -f docker-compose.production.yml build --pull app
docker compose -f docker-compose.production.yml up -d app

echo "Waiting for health..."
for i in {1..30}; do
  if curl -fsS "http://127.0.0.1:${APP_PORT:-8080}/api/health" >/dev/null; then
    echo "WHO SABI ME? v40 is healthy."
    exit 0
  fi
  sleep 2
done

echo "Health check did not pass."
docker compose -f docker-compose.production.yml logs --tail=100 app
exit 1
