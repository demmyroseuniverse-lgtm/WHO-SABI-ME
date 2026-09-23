# WHO SABI ME? v37 — Paystack Payment Integration

v37 adds a production-oriented Paystack payment foundation for Nigerian NGN coin purchases.

## Added
- Server-side Paystack transaction initialization.
- Unique transaction references tied to the internal coin purchase.
- Paystack hosted authorization URL redirect.
- Signed webhook verification using HMAC SHA512.
- Idempotent `charge.success` handling.
- Server-side amount/currency checks before crediting coins.
- Authenticated transaction verification endpoint.
- Coin ledger entry only after verified successful payment.
- Paystack configuration in `.env.example`.

Paystack recommends webhooks for reliable payment status updates and requires verification of webhook origin using the `x-paystack-signature` header.

## Production configuration
Set:
`PAYSTACK_ENABLED=true`
`PAYSTACK_SECRET_KEY=...`
`PAYSTACK_CURRENCY=NGN`
`APP_BASE_URL=https://your-domain.example`

Configure the public webhook endpoint:
`https://your-domain.example/api/paystack/webhook`

Use Paystack test keys while testing, then replace them with live keys only after the business account and production setup are ready.

## Important
The secret key must remain server-side. Do not put it in `app.js`, HTML, or browser-visible environment variables. Real payments require a properly configured Paystack account and webhook endpoint.

Ads remain separately configured through AdSense/your chosen ad provider.
