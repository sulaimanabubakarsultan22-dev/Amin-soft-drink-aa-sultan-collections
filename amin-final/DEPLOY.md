# Deploy and go-live checklist

Production storefront = `public/index.html`, served by `server.js`. There is no other storefront.

## Deploy (any Linux VPS, Node 22+)
1. Copy this folder to the server. Create `/var/lib/store` (database + backups) owned by the app user.
2. `cp .env.example .env` and fill it in (see the comments inside). `chmod 600 .env`.
3. Run behind HTTPS: Caddy example: `shop.example.com { reverse_proxy localhost:3000 }`.
4. Start with a process manager (systemd or pm2): `node --env-file=.env server.js`. Redeploys must never touch `/var/lib/store`.
5. Open `https://your-domain/#/admin`, log in with ADMIN_EMAIL / ADMIN_PASSWORD, then delete ADMIN_PASSWORD from `.env`.
6. Admin > Settings: business name, WhatsApp, phone, delivery fee, social links. Add categories, then products.
7. Paystack dashboard > Settings > API Keys & Webhooks: set Webhook URL to `https://your-domain/api/webhook/paystack`.
8. Copy `/var/lib/store/backups` off the server regularly (cron + rsync/rclone). A backup on the same disk is not enough.

## First live Paystack test (do not skip)
1. Start with `sk_test_...` key and a Paystack test card: place an order, pay, confirm it shows Paid in Admin and stock dropped once.
2. Switch `.env` to `sk_live_...`, restart. Create a product priced at ₦100 with stock 1 (hide it afterwards).
3. Order it from your own phone, pay with your own card. Confirm: order Paid, payment verified, stock 0, tracking page shows "Payment successful".
4. In Paystack, check the transaction and its webhook delivery (should be 200). Refund yourself from Paystack, then set the order to Refunded in Admin (stock is restored once).
Until step 3 succeeds, treat payments as NOT production-verified.

## Operations
- Forgot owner password: `node --env-file=.env reset-owner.js "NewLongPassword"` (needs server access).
- Staff: Admin > Staff (owner only). Reset password gives a temporary password to share privately.
- Restore: stop the app, replace `store.db` with a file from the backups folder, start.
- Payments marked `refund_due` (duplicate or late payment) must be refunded manually in Paystack.

## Known limitations
- Images are stored inside SQLite (max 700KB each, resized in the browser, cached via /img/). Fine for a few hundred products; for thousands move them to a disk folder/object storage. Backups include them.
- No product variants (size/colour) yet; no customer accounts; no email/SMS/WhatsApp sending (hook: `notify()` in server.js); no Meta posting (needs META_APP_ID/SECRET + OAuth).
- Password reset is owner-controlled (no email reset). Single server + SQLite: no horizontal scaling.
- Pages other than product pages use `#` routes (they are not meant for search engines).

### Store catalog
After creating the database, run `npm run db:seed` to add the AMIN SOFT DRINK & A.A SULTAN COLLECTIONS drink catalog. Product prices are editable in Admin. Each product supports a unit price, optional carton price, optional carton quantity, stock, photo, and (for clothes) size.
