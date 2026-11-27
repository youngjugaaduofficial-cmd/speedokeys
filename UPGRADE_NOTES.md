# Speedo Keys v2.8.0 — Codes, username, no buy limit, admin parity

- **Register** now asks for a username (3-20 letters, numbers, `_`, unique). Google sign-ups get a name made from the email.
- **6-digit reference codes** (#123456): every deposit gets one, every purchase gets one (items bought together in one checkout share the code). Customers see them in My Codes, receipts, wallet history and the payment screens. Old records get a code automatically on first start.
- **Admin search**: type `#123456` (or just the digits) in the top search, in Orders, or in Payments. Payments now has its own search box.
- **No more "Too many attempts" while buying.** The 40-per-hour purchase limit is removed; a very high per-minute guard (120/min) remains against bots. Top-up creation allows 30 per hour.
- **Admin matches the user panel**: Notices (bell), Reviews, Rewards & referrals (welcome bonus, referral reward, top-up bonus tiers, limits, referral list), Affiliates, SEO were brought back because the shop uses them. Gifts, Loyalty, Bundles, Community, Suppliers, Operations and Advanced analytics stay removed (the shop has no screens for them).

- **Launch cleanup**: Admin > Settings > "Delete test data" (type DELETE TEST DATA) removes all customers, orders, deposits, wallet history, tickets and reviews; products, keys, coupons, banners and settings stay. Optional tick makes keys sold during testing available again. Download a backup first.

---

# Speedo Keys v2.7.0 — Simple admin, new sign-up

## Admin panel
- Plain white theme with system fonts. The theme picker and neon/dark styles are gone.
- Removed from the admin menu: Operations Center, Suppliers, Affiliates, Bundles, Gifts, Loyalty, Community, Advanced analytics, SEO, Notices & push. Their API routes are still in `server.js` but have no screen; nothing in the shop calls them.
- Kept: Dashboard, Products, Banners, Orders, Payments, Coupons, Users (now searchable by email), Support chat, Appearance & tools (shop theme, CSV export, backup), Security, Activity log, Settings.

## Register / login
- Register needs: email, password (10+ characters), re-enter password, "I am 18 or older" and "I accept the Terms & Conditions". Both boxes are enforced on the server and stored as timestamps (`ageConfirmedAt`, `termsAcceptedAt`).
- The Terms link shows the text from Admin > Settings > pages.
- Display name is made from the email name (rahul.k@gmail.com -> rahulk). Login works with email or the old username.
- Continue with Google (set `GOOGLE_CLIENT_ID`). The ID token is verified server-side (audience, issuer, expiry, verified email). A new Google account needs the 18+ and Terms boxes ticked once on the Register tab.
- Typed emails are not verified (no email service is configured). If someone later signs in with Google using an email that was only typed at password sign-up, that account is claimed by Google: the old password is retired and its sessions are revoked.
- Google-only accounts have no usable password; "change password" does not apply to them.

## Housekeeping
- Cross-Origin-Opener-Policy is now `same-origin-allow-popups` so the Google popup works. Service worker cache bumped to v5. Version 2.7.0.

---

# Speedo Keys v2.6.0 — Feature and security update

## New
- Telegram alerts (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, optional `TELEGRAM_LOW_STOCK`). Admin → Security & system has a "Send test message" button. Alerts never contain customer codes, never block orders, and are capped at 20 per minute.
- Wishlist API (`GET /api/wishlist`, `POST /api/wishlist/:productId` with `{ "on": true|false }`), a ♥ button on every product and a "♥ Saved" filter.
- Product sorting (price low/high, top rated) and a search box, Copy all and CSV export in "My codes".
- Admin → Security & system: Telegram status and a Network card showing the IP the server detects for you.

## Security
- Client IP is now read from `CF-Connecting-IP` / `True-Client-IP` (or `CLIENT_IP_HEADER`) behind a trusted proxy. Previously the first `X-Forwarded-For` entry was trusted, which a client can forge, letting it dodge the ZapUPI webhook IP allowlist and the login rate limits. If no such header exists the old behaviour is used and a warning is logged. After deploying, confirm "Detected from" in the Network card does not say "spoofable".

## Housekeeping
- Service worker cache bumped to v4. Version aligned to 2.6.0. Added `.env.example`, `.gitignore` and `ENV_VARIABLES.md`.

---

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
