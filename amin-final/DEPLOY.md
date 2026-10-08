# Deploy and go-live checklist

Production storefront = `public/index.html`, served by `server.js`. There is no other storefront.

## Deploy on Render with PostgreSQL
1. Create a PostgreSQL database in Render in the same region as the web service. Select a plan with the storage and backup retention appropriate for the shop.
2. Create a Web Service for this repository and set its Root Directory to `amin-final`. Use `npm install` as the build command and Node 22.9 or newer with `npm start` as the start command.
3. In the web service's Environment settings, use **Add from database** to set `DATABASE_URL` to the new database's **internal** connection string. Keep it in Render's secret environment settings; do not put the connection string in `.env.example`, source control, or logs.
4. Set the remaining required variables in Render's Environment settings, including `NODE_ENV=production`, `PUBLIC_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `PAYSTACK_SECRET_KEY`. Keep `DB_PATH` unset when using PostgreSQL.
5. Deploy. Startup applies the repeatable PostgreSQL schema migration and seeds the catalog idempotently. It creates an initial owner only when the database has no admin. The existing SQLite file is not copied, imported, or deleted.
6. Confirm the service is healthy, sign in to `/admin`, verify the catalog and settings, then test Paystack with a test key before switching to a live key.

Render's PostgreSQL connection string is a credential. Do not print it, paste it into a committed file, or share it in support logs. `npm run db:migrate` can be used to initialize/check the schema explicitly; application startup also runs the same idempotent migration. PostgreSQL deployments use Render's database backup/restore controls; the app's local `BACKUP_DIR`/SQLite `VACUUM INTO` job is only used with SQLite.

**Do not import production SQLite data until the PostgreSQL schema and application compatibility are verified.** The safe data-migration tool is available in the section below; it is not run automatically by deployment.

### Safe SQLite data migration (run only after the PostgreSQL schema is verified)
The data migration CLI requires an explicit SQLite backup path and a PostgreSQL `DATABASE_URL`. It opens the source database read-only, starts a consistent read transaction, and never changes the SQLite source. Prefer an existing, verified file from the app's SQLite backup directory; do not point it at the live `store.db`. If no backup exists, create a consistent SQLite backup while the app is stopped, retain the original, and use the new backup as the source.

With `DATABASE_URL` set to the intended PostgreSQL destination in the local environment file, initialize only the PostgreSQL schema (this does not run catalog seeding), then run the non-writing preflight:

```sh
npm run db:migrate
npm run db:migrate-data -- --source /secure/path/to/verified-store-backup.db --dry-run
```

Review the table-by-table counts and destination conflict results. The preflight does not initialize PostgreSQL schema or write any destination data. For the actual import, run the same command with `--apply` instead of `--dry-run`. It applies the repeatable schema migration, then copies the source tables in dependency order within one PostgreSQL transaction. It does not run catalog seeding or start the web service. Do not start the Render web service before importing: app startup seeds the catalog, and a destination with conflicting category/product records is deliberately rejected rather than overwritten.

Existing destination rows with identical primary keys and values are left unchanged, so a completed import can be repeated. Destination admins are never overwritten: a source admin with an email already present in PostgreSQL is mapped to that destination admin, while an admin ID collision with a different email is imported with a generated PostgreSQL ID. Categories reconcile by name, products by SKU or exact name/category, and customers by phone; matching destination records are preserved even when their IDs differ. Primary-key collisions for unmatched records receive generated IDs, and references from dependent rows follow each mapping. Ambiguous logical identities and other conflicting records stop the import and roll back the whole data transaction. The one known schema bootstrap row (`annual_award_config.id=1` with an empty reward) may be populated from the source; any non-empty differing award config is treated as a conflict. Only unexpired sessions belonging to active admins are copied. Password hashes remain in the database, but the CLI never displays them; API keys and connection strings are never printed.

Validation checks every source row against its destination row, verifies application relationships (including product IDs referenced by historical order items), and synchronizes PostgreSQL identity sequences to the preserved IDs. A failed data transaction is rolled back; the source remains read-only. PostgreSQL integration tests use only `DATABASE_URL_TEST`, which must point to a dedicated disposable test database.

## Deploy (any Linux VPS, Node 22.9+)
1. Copy this folder to the server. Create `/var/lib/store` (database + backups) owned by the app user.
2. `cp .env.example .env` and fill it in (see the comments inside). `chmod 600 .env`.
3. Run behind HTTPS: Caddy example: `shop.example.com { reverse_proxy localhost:3000 }`.
4. Start with a process manager (systemd or pm2): `node --env-file=.env server.js`. Redeploys must never touch `/var/lib/store`.
5. Open `https://your-domain/#/admin`, log in with ADMIN_EMAIL / ADMIN_PASSWORD, then delete ADMIN_PASSWORD from `.env`.
6. Admin > Settings: business name, WhatsApp, phone, delivery fee, social links. Add categories, then products.
7. Set `PAYSTACK_SECRET_KEY` in the server environment (never in frontend code) and set `PUBLIC_URL` to the public HTTPS storefront URL. In Paystack Dashboard > Settings > API Keys & Webhooks, enable the payment methods you accept (including bank transfer if available) and set the webhook URL to `https://your-domain/api/webhook/paystack`. Checkout displays the merchant-enabled methods.
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
- Restore on SQLite: stop the app, replace `store.db` with a file from the backups folder, start. On Render PostgreSQL, restore using Render's database backup controls.
- Payments marked `refund_due` (duplicate or late payment) must be refunded manually in Paystack.

## Known limitations
- Product photos (max 700KB each) are resized in the browser and stored in the product image fields of the configured database (SQLite or PostgreSQL). The storefront serves them through `/img/` routes. For a catalog with thousands of products, move image storage to a disk folder or object storage. SQLite backups include photos; PostgreSQL photos are covered by the database's backups.
- The generated catalog artwork is not shown as product photography. Until a verified matching photo is uploaded under Admin > Products, the storefront clearly marks the photo as needed.
- Annual Customer of the Year rankings use Paystack-verified payment time in the Africa/Lagos calendar year. Cancelled/refunded orders are excluded; past top-three winners are archived on the next year's leaderboard view. Configure the reward and export rankings under Admin > Awards. Admin > Coupons manages percentage coupon codes; carton savings and product markdowns power the existing offers.
- No product variants (size/colour) yet; no customer accounts; no email/SMS/WhatsApp sending (hook: `notify()` in server.js); no Meta posting (needs META_APP_ID/SECRET + OAuth).
- Password reset is owner-controlled (no email reset). Single server + SQLite: no horizontal scaling.
- Pages other than product pages use `#` routes (they are not meant for search engines).

### Store catalog
After creating the database, run `npm run db:seed` to add the AMIN SOFT DRINK & A.A SULTAN COLLECTIONS drink catalog. Product prices are editable in Admin. Each product supports a unit price, optional carton price, optional carton quantity, stock, photo, and (for clothes) size.
