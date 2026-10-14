# Razorpay — Node.js (Express 5) + React 19 (Vite)

A multi-tenant SaaS billing core: plans with features and limits, workspaces, and subscriptions
that customers pay either by **autopay** (Razorpay mandate) or **manually each period** (payment link
reminders, no mandate), with free trials.

## Plans & features (entitlements)
Plans, what they include and what they cost live in PostgreSQL and are managed from the **Admin** tab
(`server/catalog.js`, schema in `server/migrations/001_catalog.sql`).

- **Feature catalog** (`features`): every feature a plan can grant. `boolean` features are on/off;
  `limit` features are a whole number, with `-1` for unlimited. Plans can only use keys from the
  catalog, so a typo is rejected instead of silently granting nothing. Add a feature and it shows up
  in every plan editor.
- **Plans** (`plans`) store what they grant as JSON, validated against the catalog:
  ```json
  { "features": { "custom_domain": true }, "limits": { "projects": 10, "team_members": 5 } }
  ```
  Only what the plan grants is stored: a missing key means off / 0 (deny by default).
- **Versions**: a plan starts as a `draft` that you can edit freely. Publishing makes it `active`
  (what new customers buy) and locks its features. To change them, create a new version and publish
  it: the old version becomes `archived` but keeps applying to the customers already on it.
- **Prices** (`plan_prices`) belong to a plan version, one per period (monthly / yearly). A plan with
  no prices is free. The same price is used for autopay and manual payment. Each price becomes a Razorpay plan on its first subscribe. Razorpay plans can't be
  edited, so setting a new price retires the old row, and existing subscribers keep paying the old amount.
- **Trials**: `trial_days` per plan (0 = none). It isn't an entitlement, so it can change on a published
  version and only affects people who subscribe afterwards. A workspace gets one trial, ever.
- Everything carries a `product_id` (one `default` product for now), so the same tables can later
  serve several SaaS products.

The admin API (`/api/admin/*`, `server/admin.js`) is guarded by `ADMIN_TOKEN` until there are user
accounts. `GET /api/config` returns the live version of each public plan, with every feature resolved.

## Accounts & workspaces (tenants)
Signing up (`POST /api/auth/signup`) creates a user and a **workspace** (tenant) they own.
Plans and subscriptions belong to the workspace, so every member gets its features
(`server/auth.js`, schema in `server/migrations/003_tenants_billing.sql`).

- Passwords are hashed with Node's built-in `scrypt`.
- `POST /api/auth/login` sets an httpOnly, `SameSite=Lax` cookie holding a random session token;
  only its SHA-256 hash is stored in `sessions`. `POST /api/auth/logout` deletes it.
- `GET /api/me` returns the user, the workspace (with the user's role) and the plan its features come
  from: the plan version of its live subscription, or the product's default plan (`free`).
- Only `owner` / `admin` members can subscribe or cancel. The Admin tab lists every workspace under **Tenants**.

## Subscriptions
Our `subscriptions` table is the source of truth for access (`server/billing.js`). A workspace has at
most one live subscription, and its `collection_method` says how the money is collected. The customer
picks one on the pricing page (Autopay / Pay each time); the plan and price are the same.

Statuses: `incomplete` (checkout not finished) → `trialing` → `active` → `past_due` → `halted` / `cancelled`
/ `expired`. `trialing`, `active` and `past_due` give the plan's features; anything else means the free plan.

`POST /api/subscriptions` takes `{ priceId, method: 'auto' | 'manual' }`. Before it starts, any unfinished
checkout, halted autopay subscription and unpaid invoice of the workspace is cancelled or voided, so none
can come back to life next to the new one. `GET /api/subscription` returns the latest subscription with
its payments, re-checking Razorpay first (so it's right even without webhooks, e.g. locally).
`POST /api/subscription/cancel` with `{ atCycleEnd: true }` stops renewal but keeps access until the paid period ends.

### Autopay (`auto`)
1. The server creates a Razorpay subscription (`total_count` = max number of charges) and our row as `incomplete`.
   With a trial it passes `start_at` = trial end, so the mandate is set up now and the first charge comes later.
2. React opens Checkout with `subscription_id` (no amount or order). The customer authorises a mandate
   (card / UPI Autopay / e-mandate) and, without a trial, pays the first cycle.
3. `POST /api/subscriptions/verify` checks the signature (**note the order:** `payment_id|subscription_id`)
   and that the subscription belongs to this workspace, then copies Razorpay's state onto our row.
4. From then on **Razorpay charges the customer every cycle by itself**. Webhooks (`subscription.charged`,
   `.pending`, `.halted`, `.cancelled`, `.completed`) tell us; for each one the server re-reads the
   subscription from Razorpay instead of trusting the payload, so a late or repeated event can't roll it back.

Razorpay status → ours: `created` → `incomplete`; `authenticated` → `trialing` during a trial, else `active`;
`active` → `active`; `pending` → `past_due` (Razorpay retries); `halted` → `halted`; `cancelled` → `cancelled`;
`completed` / `expired` → `expired`.

### Manual payment (`manual`, `server/manual.js`)
No mandate: the customer pays each period themselves. Each period is an `invoices` row.

1. **Start.** With a trial, the subscription starts as `trialing` straight away, with no payment details.
   Without one, the server opens the first invoice with a Razorpay order; React pays it in Checkout and
   `POST /api/invoices/:id/verify` checks the signature (`order_id|payment_id`) and the payment itself.
2. **Renewal invoice.** 7 days before the period (or trial) ends, the billing job opens the next invoice
   with a Razorpay **payment link**, so the customer can pay from a reminder without logging in.
3. **Reminders** 7, 3 and 1 days before the due date and on the day, sent by Razorpay by email (and SMS
   when the owner gave a phone number). Each is sent once; an invoice opened late skips the earlier ones.
4. **Paid** (`payment_link.paid` webhook, or a page load that re-checks the link): the period is extended
   from where the current one ends, so paying early loses nothing.
5. **Not paid by the due date:** `past_due`, features stay on for a **7-day grace period**, then `expired`
   and the workspace is on the free plan. A trial nobody paid for expires at the trial end, with no grace.
6. **Paid late, after it expired:** the link still works for 30 days after the due date; the new period
   starts on the payment day. After that the invoice is voided and the customer subscribes again.

The **billing job** runs every hour (`runBillingJob`, guarded by a Postgres advisory lock so two servers
don't run it at once) and is safe to run any time. Admin → Tenants → **Run billing job now** runs it on demand.

## Run
```bash
# database (once) — any PostgreSQL works; on Windows psql is in C:\Program Files\PostgreSQL\<version>\bin
psql -U postgres -c "CREATE DATABASE saas;"

# backend
cd server
cp .env.example .env      # put your keys, DATABASE_URL and ADMIN_TOKEN in .env
npm install
npm run dev               # http://localhost:5000 — creates the tables and starter plans on first run

# frontend (new terminal)
cd client
npm install
npm run dev               # http://localhost:5173
```

## Test payments
Use test mode keys. In Checkout pick UPI and enter `success@razorpay` (or `failure@razorpay`),
or use a Razorpay test card from the docs.

For subscriptions, the payment method must support recurring payments (card mandates or UPI Autopay).
Use the recurring/subscription test details from Razorpay's test-mode docs. Only the first charge
happens straight away; later renewals follow the plan's schedule (a month for monthly plans).
To exercise the renewal code without waiting, POST a `subscription.charged` payload to the webhook
with an `x-razorpay-signature` header = HMAC-SHA256 of the raw body using `RAZORPAY_WEBHOOK_SECRET`.

For manual renewals, move a subscription's dates back to "skip time", then run the billing job:
```sql
UPDATE subscriptions SET current_period_end = current_period_end - interval '25 days' WHERE id = <id>;
```
Admin → Tenants → **Run billing job now** then opens the invoice, creates the payment link and sends the reminder.

## Webhooks locally
Expose port 5000 (e.g. `ngrok http 5000`), then in Dashboard → Webhooks add
`https://<your-tunnel>/api/webhooks/razorpay`, set a secret (same as `RAZORPAY_WEBHOOK_SECRET`)
and subscribe to `payment.captured`, `payment.failed`, `order.paid`, `payment_link.paid`, and for
subscriptions `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`,
`subscription.halted`, `subscription.cancelled`, `subscription.completed`.

## Production checklist
- Rate-limit login and signup; add email verification and password reset.
- Plan upgrades/downgrades and switching between autopay and manual payment.
- Watch the logs for `refund it by hand`: a payment that arrived for a checkout the customer had
  already replaced (e.g. paid in two tabs). The money is recorded on the invoice but not applied.
- Set `CLIENT_ORIGIN` to the real app URL: payment links send the customer back there after paying.
- Enable auto-capture in Dashboard → Payment Capture (otherwise `authorized` payments must be captured via API).
- Switch to `rzp_live_` keys only on the server's environment; never ship the secret to the browser.
