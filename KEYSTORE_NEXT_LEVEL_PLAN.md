# Key Store — Next-Level Hybrid Upgrade Plan

## Status
This document is an implementation roadmap. These nine modules are NOT implemented in release 2.1.0.

## Design
- User panel: competitive esports style, graphite/near-black with restrained lime and orange accents; no purple gradients.
- Admin panel: strictly monochrome black, white and grey; no colored accents or gradients.

## Planned modules
1. Live Operations Center: order/payment/webhook/delivery/stock/server health, incidents and alerts.
2. Supplier Management: supplier records, purchase batches, cost history and stock traceability.
3. Affiliate System: tracked links, conversions, commission ledger, fraud checks and payout records.
4. SEO & Landing Page Manager: metadata, canonical URLs, sitemap, robots and editable landing pages.
5. Gift Purchase: recipient, gift message, scheduled delivery and redemption status.
6. Loyalty & Cashback: separate reward ledger, earning/redemption rules, expiry and refund reversals.
7. Product Bundles: bundle configuration, atomic stock reservation, individual item delivery and margin reporting.
8. Advanced Analytics: retention, repeat purchases, customer lifetime value, conversion funnel and module profitability.
9. Gaming Community: discussions, replies, reports, verified-purchase markers and moderation.

## Implementation order
- Phase 0: schema/API audit, baseline tests, backup and rollback plan.
- Phase 1: operations monitoring and supplier/purchase-batch traceability.
- Phase 2: affiliate attribution and SEO manager.
- Phase 3: gifts, loyalty ledger and bundles with idempotent transactions.
- Phase 4: advanced analytics and moderated community.
- Phase 5: regression, accessibility, mobile and production-readiness verification.

## Engineering constraints
- Keep wallet money and loyalty points in separate ledgers.
- Use idempotency for payment callbacks, affiliate commissions and reward grants.
- Atomically reserve inventory for single-key and bundle purchases.
- Never expose gift keys to unauthorized recipients.
- Preserve supplier cost history by batch.
- Sanitize community content and provide moderation/reporting controls.
- Use persistent storage, secure secrets, verified payment webhooks and tested backups in production.
