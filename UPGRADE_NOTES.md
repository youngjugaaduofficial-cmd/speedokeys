# Speedo Keys v2.4.0 — Repair release

## Security and reliability repairs
- Enforced stronger startup secrets: `ADMIN_PASSWORD` must be at least 12 characters and `JWT_SECRET` at least 32 bytes. Rotate both before deployment.
- Increased new-account and password-change minimum length to 10 characters. Existing shorter passwords can still log in, but should be changed.
- Added baseline security headers to responses and HSTS on HTTPS requests.
- Added admin session versioning and `POST /api/admin/logout-all` to revoke every active admin token.
- Added durable, 30-day idempotency records for `/api/buy` and `/api/checkout`; reusing a key with a different payload returns HTTP 409. Send `idem` in JSON or `Idempotency-Key` header.
- Replaced the conflicting inline service-worker response with the actual versioned `sw.js` file; cache version is now v3.
- Fixed sitemap generation to include published SEO slugs and omit noindex pages. SEO slugs now return server-rendered title, description and canonical/robots metadata.
- Hardened ZapUPI webhook auto-credit with a required exact source-IP allowlist (`ZAP_WEBHOOK_IPS`, comma-separated) and a 32+ character webhook secret. No allowlist means the ZapUPI configuration will not start.
- Removed raw webhook payload logging to avoid exposing payment/customer data in logs.

## Remaining deployment constraints
- The current JSON/Upstash whole-database storage model is intended for a single application instance. Do not scale horizontally until storage is migrated to a transactional database with cross-instance locking.
- ZapUPI webhook signature verification remains provider-documentation-dependent. IP allowlisting and secret URL checks are additional controls, not a substitute for a provider-signed HMAC/signature. Confirm the provider's official signature mechanism before enabling real-money auto-credit. If the provider cannot provide a stable source-IP list, keep automatic webhook credit disabled and use a verified server-to-server status API/manual reconciliation.
- Configure and test backups, restore, payment status polling and production gateway credentials before taking live payments.
- Email/SMS delivery, scheduled gifting and automated affiliate payouts remain unimplemented.

## Validation
- `npm run check`
- `npm test`
