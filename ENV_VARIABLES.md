# Environment variables

## Required (server will not start without these)
| Variable | What to put |
|---|---|
| `ADMIN_PASSWORD` | Unique admin password, 12+ characters |
| `JWT_SECRET` | Random secret, 32+ bytes (for example 40+ random characters) |

## Needed for a real deployment on free hosting
| Variable | What to put |
|---|---|
| `PUBLIC_URL` | Your HTTPS site URL without a trailing slash, e.g. `https://your-app.onrender.com` |
| `UPSTASH_REDIS_REST_URL` | REST URL from your Upstash Redis database. Without it, data lives in a local file and is lost on restart |
| `UPSTASH_REDIS_REST_TOKEN` | REST token from Upstash. Required if the URL is set |
| `DB_ENC_KEY` | Separate long random passphrase that encrypts the database. Keep an offline copy: losing it makes data unreadable |

## Sign in with Google (optional)
| Variable | What to put |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth *Web application* client ID from Google Cloud Console (APIs & Services > Credentials). Add your site URL (e.g. `https://your-app.onrender.com`) under "Authorized JavaScript origins". Without it the Google button is hidden |

## Payments
| Variable | What to put |
|---|---|
| `GATEWAY` | `mock` (test only, no real money) or `zapupi`. Leave as `mock` until payment tests pass |
| `ZAPUPI_API_KEY` (or `ZAP_KEY`) | Your ZapUPI API key. Required when `GATEWAY=zapupi` |
| `ZAP_WEBHOOK_SECRET` | 32+ random characters. Required for zapupi. Your webhook URL becomes `https://YOUR-SITE/api/zapupi/webhook/<this secret>`. Do not share it |
| `ZAP_WEBHOOK_IPS` | Exact source IP(s) ZapUPI sends webhooks from, comma-separated. Required for zapupi; confirm them with ZapUPI |
| `ZAP_STATUS_URL` | Optional. ZapUPI's payment-status API URL from their docs, so the server can double-check payments directly |

## Telegram alerts (optional)
| Variable | What to put |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your chat id (from `https://api.telegram.org/bot<TOKEN>/getUpdates` after messaging your bot) |
| `TELEGRAM_LOW_STOCK` | Alert when stock drops to this number. Default `3`; `0` alerts only on out-of-stock |

## Optional
| Variable | What to put |
|---|---|
| `ONESIGNAL_APP_ID`, `ONESIGNAL_REST_API_KEY` | For the admin "send push notification" feature |
| `CLIENT_IP_HEADER` | Only if Admin → Security & system → Network says "spoofable": name of the header your host uses for the real visitor IP |
| `TRUST_PROXY` | `1` or `0`. Defaults to on automatically on Render. Leave unset on Render |
| `PORT` | Set automatically by Render. Default 3000 |
| `DATA_FILE` | Local-file database path. Only used when Upstash is not set |

## Minimum for a first test on Render
`ADMIN_PASSWORD`, `JWT_SECRET`, `PUBLIC_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `DB_ENC_KEY`, `GATEWAY=mock`.
