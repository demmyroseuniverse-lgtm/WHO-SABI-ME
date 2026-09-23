# WHO SABI ME? v26 — Admin & Moderation Center

## Included
- Platform overview statistics
- User search and active/suspended/banned status controls
- Session invalidation when a user is suspended or banned
- Report workflow: open, reviewing, resolved, dismissed
- Live puzzle-game monitoring and admin game termination
- Persistent custom puzzle word bank (up to 5,000 words)
- Community announcements with notification fan-out
- Appeals queue and approval/rejection workflow
- Economy transaction/revenue oversight
- Database backup action

## Important production notes
- Set a strong `ADMIN_USERNAME` and protect the administrator account with a strong password.
- Add role-based admin accounts rather than a single admin identity before multi-admin operation.
- Add audit logging for every moderation action.
- Put the admin area behind HTTPS and a reverse proxy/WAF.
- Payment provider settlement, signed webhooks, idempotency and reconciliation are still required before real-money charging.
