# Key Store — Next-Level Hybrid Upgrade

## Release 2.2.0 implementation status
The nine requested modules now have backend APIs and Admin/customer UI entry points. Existing login, wallet, catalog, inventory, orders, coupons, referrals, support, reviews, notifications, settings, security and reporting are retained rather than duplicated.

## Implemented modules
1. Operations Center — live payment/order/stock/storage health and incident log.
2. Supplier Management — supplier directory, stock batches, supplier references and per-code purchase cost history.
3. Affiliate System — tracking links, attribution, purchase conversions, commission ledger and manually recorded payouts.
4. SEO Manager — per-page title/description/canonical/noindex metadata, `robots.txt` and XML sitemap.
5. Gift Purchase — wallet-funded gift orders, recipient account binding, message and recipient-only gift-code view.
6. Loyalty — separate points ledger, earning rules and points-to-wallet-credit redemption (100 points = ₹1).
7. Product Bundles — admin-configured bundles, stock validation, grouped code delivery and wallet debit.
8. Advanced Analytics — repeat customer rate, lifetime value, affiliate/gift/bundle/community metrics.
9. Gaming Community — discussions, replies, verified-purchase marker, reports and admin moderation.

## Known scope limits
- Gift delivery currently targets an existing store username; email/SMS dispatch and scheduled delivery are not configured.
- Affiliate payout records are manual; no bank/UPI payout API is connected.
- Loyalty conversion is a store wallet credit, not cash withdrawal.
- Free hosting is for a low-traffic test/MVP. Configure remote persistent storage; do not use local JSON storage on an ephemeral free host.
- Real payment settlement requires provider credentials, webhook configuration and end-to-end verification. Mock payment is test-only.

## Design
- Customer panel: competitive esports graphite design with restrained lime/orange accents.
- Admin panel: strict black, white and neutral grey.

## Validation
Run `node preflight.js`, `node --check server.js`, `node --check test.js` and `npm test`.
