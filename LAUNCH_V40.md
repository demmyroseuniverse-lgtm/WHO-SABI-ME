# WHO SABI ME? v40 — Full Launch Package

## What is included
- Node 22 production container
- Docker Compose production profile
- Persistent SQLite data volume
- Persistent backup volume
- Read-only application filesystem with `/tmp` tmpfs
- No-new-privileges and dropped Linux capabilities
- Container healthcheck
- Graceful shutdown
- `deploy.sh` deployment script
- `backup.sh` data backup script
- `restore.sh` guarded restore script
- Caddy and Nginx reverse-proxy examples
- Production environment template
- Paystack live-mode configuration placeholders
- AdSense configuration placeholders
- Rewarded-ad production safety defaults

## Important architecture note
The current application persists its primary application data through the existing SQLite storage layer. PostgreSQL and Redis files from earlier versions are retained as integration foundations, but v40 does **not** claim that the whole application has been migrated to PostgreSQL. Do not point a production claim at PostgreSQL until a migration is implemented and tested.

## Launch sequence
1. Obtain a domain and point DNS to the production server.
2. Copy `.env.production.example` to `.env.production`.
3. Replace every placeholder with real values.
4. Set `APP_BASE_URL` to the HTTPS domain.
5. Configure HTTPS using Caddy, Nginx + Certbot, or your managed platform's TLS.
6. Configure Paystack's production webhook at `/api/paystack/webhook`.
7. Use the Paystack LIVE secret only on the server/secret manager.
8. Test a small live transaction before opening the coin store publicly.
9. Configure AdSense publisher/slot IDs and `ADS_ENABLED=true` only after the domain/account is approved.
10. Keep rewarded ads disabled until a real provider performs server-side reward verification.
11. Run `./deploy.sh`.
12. Verify `/api/health` and `/api/ready`.
13. Schedule `./backup.sh` at least daily and retain multiple backup generations off-host.

## Paystack safety
Paystack webhooks must be publicly reachable and their `x-paystack-signature` must be verified before processing. The app already validates the HMAC-SHA512 signature and uses transaction references to prevent duplicate coin credits.

## Advertising safety
Do not tell users to click ads, pay users to click standard ads, or use click-exchange/automated traffic. Standard ad earnings are controlled by the ad provider and can be adjusted for invalid activity. Rewarded advertising should be implemented only through a provider that verifies completion server-side.

## Before real public launch
- [ ] HTTPS works
- [ ] DNS is correct
- [ ] Production secrets are not committed
- [ ] Paystack LIVE keys configured
- [ ] Paystack webhook tested
- [ ] Payment/refund flows tested
- [ ] AdSense approved and configured
- [ ] `ads.txt` deployed for the correct publisher ID
- [ ] Rewarded-ad provider verified
- [ ] Admin account secured
- [ ] Daily backups scheduled
- [ ] Backup restore tested
- [ ] Error/log monitoring configured
- [ ] Privacy policy and terms published
- [ ] Support/contact channel published
- [ ] Business/payment/tax requirements reviewed for the jurisdiction in which the service operates
