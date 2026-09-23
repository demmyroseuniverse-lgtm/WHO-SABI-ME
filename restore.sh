#!/usr/bin/env bash
set -euo pipefail
ARCHIVE="${1:-}"
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "Usage: ./restore.sh backups/who-sabi-me-YYYYMMDDTHHMMSSZ.tar.gz"
  exit 1
fi

echo "This will replace application data with $ARCHIVE. Stop the app first."
read -r -p "Type RESTORE to continue: " CONFIRM
[[ "$CONFIRM" == "RESTORE" ]] || exit 1

docker compose -f docker-compose.production.yml stop app
docker run --rm -i -v "$(docker volume ls -q | grep -E 'who.*app_data|app_data' | head -1):/restore" -v "$(pwd)/$(dirname "$ARCHIVE"):/backup:ro" alpine:3.20 sh -lc 'rm -rf /restore/* && tar -xzf "/backup/$(basename "$1")" -C /restore' sh "$(basename "$ARCHIVE")"
docker compose -f docker-compose.production.yml start app
