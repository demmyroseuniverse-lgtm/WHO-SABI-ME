# WHO SABI ME? v35 — Advertising Monetization

## Model
- Standard website ad placements are available on Home, Feed, Discover and Premium areas.
- The build supports Google AdSense-style web ads through environment configuration.
- Rewarded ads remain a separate voluntary coin-reward system.
- Free Arena Membership remains free. Premium experiences continue to consume coins.

## Important revenue rule
This is **not** a guaranteed pay-per-click system. Advertising revenue depends on the ad network, advertiser demand, geography, valid traffic, ad format and whether the network pays for an impression, click or another event. Modern AdSense for Content is primarily impression-based for publisher payments, while CPC can still be an auction metric for individual ads.

## Production setup
Set `ADS_ENABLED=true`, your real `ADSENSE_PUBLISHER_ID`, and real ad-slot IDs in the deployment environment. Complete the ad network's site verification and policy requirements before serving production ads.

Do not ask users to click ads, click your own ads, use click-exchange/paid-to-click traffic, or otherwise inflate clicks/impressions. The ad network must receive genuine user traffic.

## Revenue dashboard
The admin Ads tab records internal ad-placement views. Actual clicks, CTR, eCPM/RPM and finalized revenue must be read from the connected ad provider; the website does not invent or guarantee those earnings.
