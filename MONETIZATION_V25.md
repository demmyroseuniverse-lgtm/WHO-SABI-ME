# WHO SABI ME? v25 — Monetization & Economy Foundation

v25 adds a server-side economy foundation without pretending a payment has been completed.

## Included
- Virtual coin wallet and ledger
- Coin-pack catalog priced in Nigerian naira (amounts stored as kobo)
- Arena Plus monthly/annual plan catalog
- Server-side checkout transaction records
- User transaction history
- Admin economy summary endpoint
- Demo coin credit for local testing only

## Payment status
The checkout endpoint intentionally creates a `pending` transaction and does **not** charge a card. A real provider such as Paystack or Flutterwave must be connected before production payments are enabled. Provider webhooks should mark transactions completed only after verified payment events.

## Production requirements before charging users
- Provider credentials stored as secrets
- Signed webhook verification
- Idempotent transaction processing
- Payment reconciliation
- Refund handling
- Fraud/chargeback controls
- Receipts and transaction history
- Nigerian tax/legal review as applicable
