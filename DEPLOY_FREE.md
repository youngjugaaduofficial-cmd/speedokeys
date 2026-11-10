# Free deployment guide (test / MVP)

## Recommended free stack
- **Render Free Web Service** for the Node.js app.
- **Upstash Redis Free** for durable database storage. Do not rely on the app's local `data.json` on a free host: free web-service filesystems can be wiped on restart, redeploy or idle spin-down.
- A free `onrender.com` subdomain initially; connect a custom domain later if desired.

Free tiers have quotas and cold starts. This is suitable for a low-traffic test/MVP, not a promise of production-grade uptime or payment reliability. Render documents that free services spin down after 15 minutes idle and local files are ephemeral. Upstash currently lists 256 MB, 10 GB monthly bandwidth and 500,000 commands/month on its Redis Free plan; check current plan terms before launch.

## Deploy
1. Extract this ZIP and push the project folder to a private GitHub repository.
2. In Render, choose **New → Web Service**, connect the repository, select **Node**, set Build Command to `npm install` and Start Command to `npm start`, then choose the Free instance.
3. Create a Redis database at Upstash. Copy its REST URL and REST token.
4. In Render → Environment, add:
   - `ADMIN_PASSWORD` — a unique admin password of at least 12 characters.
   - `JWT_SECRET` — a cryptographically random secret of at least 32 bytes.
   - `DB_ENC_KEY` — a separate long random passphrase; keep a secure offline copy. Losing it makes encrypted data unreadable.
   - `UPSTASH_REDIS_REST_URL` — the Upstash REST URL.
   - `UPSTASH_REDIS_REST_TOKEN` — the Upstash REST token.
   - `PUBLIC_URL` — your deployed HTTPS URL, without a trailing slash.
   - `GATEWAY` — leave unset or use `mock` only for testing. Mock payment is not real money.
5. Deploy. Open `/api/health` and `/admin.html`. Log in with the `ADMIN_PASSWORD` you configured.
6. In Admin → Security & system, verify persistent storage and encryption. Download a backup before adding real inventory.
7. Configure a real payment gateway only after obtaining provider credentials and webhook settings. For the current ZapUPI integration, configure `GATEWAY=zapupi`, `ZAPUPI_API_KEY` (or `ZAP_KEY`), `ZAP_WEBHOOK_SECRET` (32+ random characters), `ZAP_WEBHOOK_IPS` (exact provider source IPs, comma-separated), and the provider's required callback/status settings. The app refuses to start in ZapUPI mode without the IP allowlist. Provider signature verification is not yet implemented; confirm ZapUPI's official signing specification and add/verify it before enabling live auto-credit. Test successful, failed, duplicate and amount-mismatch callbacks before selling anything.

## Before real sales
- Add only genuine, legally sourced gift-card codes and verify their country/region restrictions.
- Configure and test a real payment provider; do not accept the mock payment flow as proof of payment.
- Test code delivery, refunds, supplier batch traceability, backup restore, admin 2FA and customer support.
- Free hosting can sleep, restart, rate-limit or exceed quotas. Monitor usage and keep independent backups. For a live commercial store, plan for paid compute/storage and a payment-provider-approved production setup.

## Free hosting limitations
- Render free services may cold-start after idle time and use ephemeral local storage.
- Upstash free has finite storage, bandwidth and command quotas.
- A custom domain may be available, but domain registration itself is usually paid.
- No email-based gift delivery is configured. Gift purchases currently require an existing recipient account on this store; the gift code appears in that recipient's account.
- Scheduled gift delivery and automated affiliate payout transfers are not enabled. Affiliate payouts are recorded manually by the admin.
