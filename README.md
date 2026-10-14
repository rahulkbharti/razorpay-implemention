# Razorpay — Node.js (Express 5) + React 19 (Vite)

## Flow
1. React asks the server to create an order (`POST /api/orders`) — the **server** decides the price.
2. React opens Razorpay Checkout with the returned `order_id`.
3. On success, Checkout returns `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`.
4. React sends those to `POST /api/payments/verify`; the server checks the HMAC-SHA256
   signature (`order_id|payment_id` signed with your key secret) and re-fetches the payment from Razorpay.
5. Webhook `POST /api/webhooks/razorpay` is the source of truth for fulfilment (covers closed tabs, network drops).

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
  no prices is free. Each price becomes a Razorpay plan on its first subscribe. Razorpay plans can't be
  edited, so setting a new price retires the old row, and existing subscribers keep paying the old amount.
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

## Subscriptions (recurring payments)
Our `subscriptions` table is the source of truth for access (`server/billing.js`). Each row has a
`collection_method`: `auto` (a Razorpay Subscription with a mandate) or `manual` (the customer pays each
cycle themselves; coming next). A workspace has at most one live subscription.

1. The logged-in owner calls `POST /api/subscriptions` with a `priceId`. The server creates a Razorpay
   subscription (`total_count` = max number of charges), stores our row as `incomplete`, and returns the
   `subscription_id`. Unfinished checkouts and halted subscriptions from before are cancelled at Razorpay first.
2. React opens Checkout with `subscription_id` (no amount or order). The customer authorises a
   mandate (card / UPI Autopay / e-mandate) and pays the first cycle.
3. Checkout returns `razorpay_payment_id`, `razorpay_subscription_id`, `razorpay_signature`.
   `POST /api/subscriptions/verify` checks the signature (**note the order:** `payment_id|subscription_id`)
   and that the subscription belongs to this workspace, then copies Razorpay's state onto our row.
4. From then on **Razorpay charges the customer every cycle by itself**, with nobody on your site.
   You hear about renewals through webhooks (`subscription.charged` each cycle, `subscription.pending` /
   `subscription.halted` when charges fail, `subscription.cancelled`, `subscription.completed`). For each
   one the server re-reads the subscription from Razorpay instead of trusting the payload, so a late or
   repeated event can't roll the status back.
5. `GET /api/subscription` returns the workspace's latest subscription and its invoices, re-syncing from
   Razorpay first (so it stays right even without webhooks, e.g. locally).
   `POST /api/subscription/cancel` cancels: `{ atCycleEnd: true }` stops renewal but keeps access until the paid period ends.

Razorpay status → ours: `created` → `incomplete`; `authenticated` / `active` → `active`;
`pending` → `past_due` (still has access while Razorpay retries); `halted` → `halted`;
`cancelled` → `cancelled`; `completed` / `expired` → `expired`. Only `active` and `past_due` give the plan's features.

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

## Webhooks locally
Expose port 5000 (e.g. `ngrok http 5000`), then in Dashboard → Webhooks add
`https://<your-tunnel>/api/webhooks/razorpay`, set a secret (same as `RAZORPAY_WEBHOOK_SECRET`)
and subscribe to `payment.captured`, `payment.failed`, `order.paid`, and for subscriptions
`subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`,
`subscription.halted`, `subscription.cancelled`, `subscription.completed`.

## Production checklist
- Move the in-memory `orders` Map into the database.
- Rate-limit login and signup; add email verification and password reset.
- Make one-time order fulfilment idempotent (store processed payment ids) — `order.paid` can be redelivered.
- Plan upgrades/downgrades: `razorpay.subscriptions.update(id, { plan_id, schedule_change_at })`.
  Free trials: pass `start_at` (a future timestamp) when creating the subscription.
- Enable auto-capture in Dashboard → Payment Capture (otherwise `authorized` payments must be captured via API).
- Switch to `rzp_live_` keys only on the server's environment; never ship the secret to the browser.
