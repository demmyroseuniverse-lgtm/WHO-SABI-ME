# WHO SABI ME? v39 — Owner Revenue & Production Launch

v39 adds an owner-facing revenue snapshot and a production launch readiness checklist.

## Owner Revenue
- Gross recorded Paystack coin purchases
- Processed refund amounts
- Net recorded payment value
- Completed/pending payment counts
- Creator marketplace coin activity
- Creator payout coin activity
- Internal ad placement view telemetry

Ad revenue is intentionally not estimated from clicks or internal impressions. Finalized advertising earnings come from the connected ad provider dashboard.

## Launch Checklist
The Admin → Launch tab checks application configuration for Paystack, HTTPS/production mode, AdSense publisher and slots, rewarded-ad provider verification, admin configuration, and persistence. It is a configuration check, not a provider approval or guarantee of revenue.

## Production notes
Paystack recommends webhook-based confirmation before delivering value, public webhook reachability, signature verification, and safe handling of duplicate events.

Before launch: connect your real domain, configure secrets through your hosting provider, run Paystack test transactions, configure the live webhook URL, complete AdSense/domain approval, and verify the rewarded-ad provider server-side.
