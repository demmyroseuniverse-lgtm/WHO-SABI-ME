# WHO SABI ME? v38 — Production Payments & Refunds

v38 hardens the v37 payment foundation and fixes economy initialization.

## Added
- Paystack `charge.success` webhook endpoint at `/api/paystack/webhook`.
- HMAC-SHA512 signature verification using the Paystack secret key.
- Idempotent payment crediting: a completed transaction cannot credit coins twice.
- Server-side amount/currency matching before coins are issued.
- Refund event tracking for pending/processing/needs-attention/failed/processed states.
- Admin Payments dashboard with payment totals and recent transactions.
- Admin refund initiation through Paystack's refund API.
- Payment return handling so the app verifies a returned reference and informs the user.
- Fixed economy initialization so wallets/subscriptions are created for the requested username rather than relying on an out-of-scope variable.
- Updated package version to 0.38.0.

## Production setup
Set `PAYSTACK_ENABLED=true`, a server-only `PAYSTACK_SECRET_KEY`, `PAYSTACK_CURRENCY=NGN`, and `APP_BASE_URL=https://your-domain`.
Configure this public webhook in Paystack: `https://your-domain/api/paystack/webhook`.

Paystack documents webhook signature validation with the `x-paystack-signature` HMAC-SHA512 header and recommends webhooks for reliable payment status updates. Refunds are initiated through Paystack's Refund API and their status can be tracked through refund webhook events.

Never put the Paystack secret key in browser code. Test with test keys before switching to live mode.
