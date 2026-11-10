# Speedo Keys / Key Store — v2.4.0

A zero-dependency Node.js gift-card and digital-key reseller storefront with customer accounts, wallet, stock-backed automatic code delivery, admin management and nine additional hybrid modules.

## Local run
Requires Node.js 20.6 or newer.

```bash
ADMIN_PASSWORD='use-a-unique-password-of-12-chars-minimum' JWT_SECRET='use-a-random-secret-of-at-least-32-bytes-here' GATEWAY=mock npm start
```

Open `http://localhost:3000` for the store and `http://localhost:3000/admin.html` for the admin panel. The mock payment flow is for local testing only and does not collect real money.

## v2.4.0 security and reliability repairs
- Stronger environment-secret requirements and 10-character minimum for new/change passwords.
- Baseline response security headers and HTTPS HSTS.
- Admin token versioning plus `POST /api/admin/logout-all` for emergency session revocation.
- Durable 30-day idempotency for `/api/buy` and `/api/checkout`, including payload mismatch detection.
- Actual `sw.js` is now served, with a bumped cache version.
- Dynamic SEO sitemap and server-rendered metadata for configured SEO slugs.
- ZapUPI webhook auto-credit now requires a configured exact source-IP allowlist; raw webhook payloads are no longer logged.

## Validate

```bash
node preflight.js
node --check server.js
node --check test.js
npm test
```

## Deploy
See [DEPLOY_FREE.md](DEPLOY_FREE.md). A free web host needs a separate persistent datastore; do not rely on local JSON files for production inventory or customer balances.

## Key endpoints
- `GET /api/admin/operations` — operations dashboard
- `/api/admin/suppliers` and `/api/admin/supplier-batches` — supplier stock intake
- `/api/admin/affiliates`, `/api/affiliate/track/:code`, `/api/affiliate/apply` — affiliate tracking
- `/api/admin/seo`, `/api/seo/:slug`, `/robots.txt`, `/sitemap.xml` — SEO metadata
- `/api/gifts/*` — gift purchases and recipient account delivery
- `/api/loyalty/*` — separate points ledger and redemption
- `/api/bundles` and `/api/admin/bundles` — product bundles
- `/api/admin/analytics/advanced` — customer and module analytics
- `/api/community/*` and `/api/admin/community` — moderated community

## Important scope notes
- The current JSON/Upstash whole-database design is single-instance only; do not scale to multiple app instances until migrated to transactional storage with cross-instance locking.
- ZapUPI provider signature verification is not implemented because the provider-specific signing contract has not been confirmed. IP allowlisting and the secret callback path are not a replacement for provider-signed HMAC/signature verification. Confirm official provider docs before enabling real-money auto-credit.
- Rotate `ADMIN_PASSWORD` (12+ chars) and `JWT_SECRET` (32+ random bytes) when upgrading. Configure `ZAP_WEBHOOK_IPS` with the provider’s exact webhook source IP(s) if using ZapUPI; the app refuses to start in ZapUPI mode without it.

Gift codes are currently delivered to an existing recipient username inside the recipient's store account. External email/SMS delivery and scheduled gift delivery are not connected. Affiliate payouts are recorded manually; no automatic bank/UPI payout API is connected. A real payment provider must be configured and tested before real sales.
