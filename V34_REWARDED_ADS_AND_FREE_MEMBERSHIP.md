# WHO SABI ME? v34 — Rewarded Ads + Free Membership

## Changes from v33
- Platform/Arena membership is now **free**. There is no paid Arena Plus subscription.
- Users can purchase virtual coins with supported payment checkout records.
- Users can also earn coins by watching rewarded ads.
- Rewarded ad reward: **20 coins per completed ad**.
- Rewarded-ad limit: **10 completed ads per day per user**.
- Cooldown: **60 seconds** between rewarded-ad claims.
- Every premium creator pack must now have a price of at least 1 coin.
- Creator pack purchases, creator support/memberships, payouts and other premium experiences continue to use coins.
- The existing real-money payment checkout remains a foundation; a payment provider still needs to be connected before charging real money.

## Rewarded ads production requirement
The current browser flow demonstrates the user experience and calls `/api/economy/reward-ad`. Before production, replace the demo completion with a real rewarded-ad provider SDK/server-to-server verification. The server should only credit coins after receiving a valid signed reward callback from the provider, with idempotency protection and fraud/rate controls.
