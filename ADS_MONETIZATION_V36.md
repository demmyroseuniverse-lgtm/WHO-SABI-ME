# WHO SABI ME? v36 — Ad Monetization & Compliance Layer

## What was added
- Production `/ads.txt` endpoint generated from the configured AdSense publisher ID.
- Admin Ads health data: publisher configuration, slot configuration, ads.txt readiness and rewarded-ad verification state.
- Rewarded coin claims are now blocked unless `REWARDED_ADS_PROVIDER=verified`. This prevents the demo reward endpoint from being mistaken for a real ad-network completion signal.
- Standard display ads remain provider-controlled; the app only records its own placement-view telemetry. Actual clicks, CTR, eCPM/RPM and finalized revenue remain in the ad provider dashboard.

## AdSense setup
1. Obtain an approved AdSense account and add/verify the production domain.
2. Set `ADS_ENABLED=true`.
3. Set `ADSENSE_PUBLISHER_ID` to your real publisher ID.
4. Set the four real ad-slot IDs.
5. Deploy and confirm `/ads.txt` is reachable at the root of the domain.
6. Review the provider dashboard for actual impressions, clicks and finalized earnings.

## Critical policy protection
Do not ask users to click ads, compensate users for ordinary ad clicks/views, run click-exchange or paid-to-click traffic, or use bots/automation to inflate traffic. Display ads must remain clearly distinguishable from site controls.

## Rewarded ads
The existing watch-to-earn coin feature is now explicitly gated. A real provider must send a server-verifiable completion signal before the server credits coins. The server should validate the provider's signed callback/token, enforce one-time use/idempotency, daily limits and fraud controls, then write the coin ledger entry.

## Revenue reality
v36 does not guarantee a fixed amount per click. Publisher revenue can come from impressions and/or valid clicks depending on the ad product and auction. Finalized earnings are determined by the advertising provider after invalid-traffic filtering and other adjustments.
