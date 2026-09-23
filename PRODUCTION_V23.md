# WHO SABI ME? v23 — Production Data & Realtime Foundation

v23 keeps SQLite as the safe local fallback while adding production deployment scaffolding for PostgreSQL, Redis and resilient SSE.

## Production path
1. Provision PostgreSQL and Redis.
2. Set `DATABASE_URL` and `REDIS_URL` in the deployment environment.
3. Install the `pg` package in the production image if PostgreSQL mode is enabled.
4. Run the migration/import procedure before switching traffic.
5. Put the app behind HTTPS and a reverse proxy/load balancer.

## Realtime
The existing SSE transport now sends retry hints and heartbeats so mobile clients can reconnect cleanly after idle network timeouts.

## Important
`docker-compose.production.yml` is a deployment scaffold. Change the example PostgreSQL password before production and do not commit real secrets.
