# WHO SABI ME? — v21 Production Foundation

This release builds on v20 and prepares the MVP for production deployment.

## Added in v21
- Production-ready security headers including CSP and HSTS in HTTPS mode
- Configurable API rate limiting
- Configurable JSON request-body size limit
- Request IDs for troubleshooting
- `/api/health` and `/api/ready` health/readiness endpoints
- Graceful SIGTERM/SIGINT shutdown with SQLite persistence
- Updated SQLite state version to 21
- Environment configuration example
- Node 22 runtime target

## Run
```bash
npm start
```

Check syntax:
```bash
npm run check
```

Health: `GET /api/health`
Readiness: `GET /api/ready`

## Production notes
- Put the app behind HTTPS and a reverse proxy/load balancer.
- Set `NODE_ENV=production`.
- Keep the `data/` directory on persistent storage.
- Back up the SQLite database regularly.
- Configure email delivery before enabling real password-reset/verification emails.
- Use a dedicated process manager/container platform for restart and monitoring.


## v24 Security & Account System
- Password policy: configurable minimum length (default 10) with letters and numbers.
- Login rate limiting.
- Secure HttpOnly session cookies; session IDs are no longer returned in JSON.
- Email-verification enforcement can be enabled with `REQUIRE_EMAIL_VERIFIED=true`.
- Change password, sign out all sessions, session listing/revocation.
- Account blocking and interaction checks.
- Security status endpoint.


## v26 — Admin & Moderation Center
Adds an admin control center for user status management, report workflows, live-game moderation, persistent puzzle word bank, announcements, appeals, platform statistics, and economy oversight.

Admin access is controlled by `ADMIN_USERNAME` (default `admin`). Real payment settlement is still not connected; economy transactions remain pending until a payment provider and verified webhooks are integrated.


## v32 — AI Creator Assistant
- AI-assisted quiz idea generation, captions, hashtags and difficulty suggestions.
- Local assistant works without an external API.
- Optional compatible external AI provider can be configured with `AI_API_URL` and `AI_API_KEY` on the server; secrets are never sent to browsers.
- Recommendations use creator marketplace activity and creator content signals.
- AI-generated suggestions should be reviewed for accuracy before publication.


## v33
AI-powered player experience: personalized insights, adaptive difficulty guidance, game coach, recommendations and smart matchmaking. See V33_AI_PLAYER.md.

## v34
Rewarded-ad coin earning and free platform membership. Users can buy coins or earn coins from rewarded ads; premium experiences remain coin-based. See README_V34.md and V34_REWARDED_ADS_AND_FREE_MEMBERSHIP.md.


## v39
Owner Revenue dashboard and production launch readiness checks.
