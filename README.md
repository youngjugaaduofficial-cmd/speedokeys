# Speedo Key Shop

Dark-neon digital-key storefront with an admin panel, wallet, categories, product links, coupons, referrals, key inventory, order history, and maintenance mode.

## Requirements
- Node.js 20.6+
- Upstash Redis REST credentials for persistent production storage on Render
- A real payment gateway configuration before accepting real payments

## Render environment variables
Set these in **Render → Service → Environment** (do not commit real secrets):
- `ADMIN_PASSWORD`: strong admin login password
- `JWT_SECRET`: long random secret (at least 32 random characters recommended)
- `UPSTASH_REDIS_REST_URL`: Upstash Redis REST URL
- `UPSTASH_REDIS_REST_TOKEN`: Upstash Redis REST token
- `PUBLIC_URL`: public Render URL, e.g. `https://your-service.onrender.com`
- `GATEWAY`: `mock` for testing; `zapupi` only when ZapUPI credentials/webhook are configured
- `ZAPUPI_API_KEY` (or `ZAP_KEY`): required for ZapUPI
- `ZAP_WEBHOOK_SECRET`: random secret of at least 16 characters for the webhook URL
- Optional `ZAP_WEBHOOK_IP`: restrict webhook source IP if your gateway publishes stable IPs
- Optional `TRUST_PROXY=1` when running behind a trusted reverse proxy

## Deploy
1. Upload the project files to your GitHub repository.
2. In Render, connect the repository as a **Web Service**.
3. Build command: `npm install` (there are no external dependencies).
4. Start command: `npm start`.
5. Set the environment variables above.
6. Confirm `/api/health` returns `{ "ok": true, ... }`.

## Tests
Run `npm test` with Node.js 20.6 or newer. Tests use a temporary local data file and mock payments; they do not charge money or contact Upstash/ZapUPI.

## Payment warning
`GATEWAY=mock` is test-only and simulates wallet top-ups. The current ZapUPI adapter creates payment orders and accepts the configured webhook, but the provider's signed webhook/status-verification contract must be confirmed with ZapUPI before production use. Do not manually approve a top-up unless you have independently verified that the money arrived.
