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
- **Overrides** (Admin → Tenants → Overrides): features and limits that differ from the plan for one
  workspace, e.g. a negotiated deal ("500 projects for Acme"). Stored on `tenants.overrides` in the same
  JSON shape, validated against the catalog, with a note saying why. Every value given replaces the
  plan's, `false` and `0` included (so a feature can also be turned off for one workspace). They apply
  whatever plan the workspace is on, until an admin sets them back to "Same as plan".
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

### Changing plans (`server/changes.js`)
`POST /api/subscription/change/preview { priceId }` says what a change would do (when, the charge, and
what the workspace would lose); `POST /api/subscription/change` does it.

| Change | When | Charge |
|---|---|---|
| Dearer plan, same period length | now | `(new − old) × share of the period left`, paid in Checkout (an `upgrade` invoice); under ₹1 isn't charged |
| Cheaper plan | when the period ends | none: they keep what they paid for |
| Monthly ↔ yearly | when the period ends (manual only) | the renewal is invoiced at the new price |
| Anything during a trial | now | none |

- Scheduled changes live on the subscription (`pending_plan_id`, `pending_price_id`, `pending_change_at`);
  the billing job applies them when the period begins, and a manual renewal is invoiced at the new price.
  `POST /api/subscription/change/cancel` drops one.
- Autopay: Razorpay is told first (`subscriptions.update` with `schedule_change_at: 'cycle_end'`), so if
  it refuses (not every mandate can change amount) nothing has changed or been charged. The prorated
  difference is our own order. Undoing a change re-schedules the plan the workspace is on, rather than
  just cancelling Razorpay's scheduled changes, because after a paid upgrade Razorpay's own plan is still
  the old one until the cycle ends. Autopay can't change period length: switch to manual first.
- Past due: pay first. Cancelling: no changes.

### Switching how it's paid
`POST /api/subscription/method { method }`. Autopay → manual: Razorpay stops after this cycle, the row
becomes `manual`, and later events about that Razorpay subscription are ignored. Manual → autopay: a new
Razorpay subscription with `start_at` = the end of the current (already paid) period; Checkout authorises
the mandate, `POST /api/subscription/method/verify` switches the row and voids the renewal invoice.

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

## Enforcing plans (entitlements)
`server/entitlements.js` answers "may this workspace do this?" from the plan its features come from
(its paid or trial plan version, else the free plan). The server enforces it for every gated action;
the client only uses it to show or hide things.

```js
// An on/off feature: 403 unless the plan has it.
router.put('/workspace/domain', requireUser, requireFeature('custom_domain'), handler);

// A limit: counts and creates in one transaction, under a per-workspace lock, so two requests at
// once can't both slip under the limit.
registerUsage('projects', (db, tenantId) => /* SELECT count(*) ... */);
await withinLimit(req, 'projects', (c) => c.query('INSERT INTO projects ...'));

// Anything else: const ent = await entitlementsFor(req); ent.can('sso'); ent.limit('projects');
```

- Anything the plan doesn't grant is denied, including keys that aren't in the catalog. A key that
  isn't there (a typo in the code) is logged once, so it doesn't fail silently.
- A refusal is a `403` the client can act on:
  `{ error, code: 'limit_reached', feature, limit, used, upgradeTo: { key, name } }` or
  `{ error, code: 'feature_not_in_plan', feature, upgradeTo }`. `upgradeTo` is the first paid public
  plan that would allow it.
- **Downgrades never delete anything.** Over a limit, existing items stay and only adding more is
  blocked. A feature that's turned off stops working, but its settings are kept (a saved custom domain
  is marked inactive), so everything works again after an upgrade. Removing things is always allowed.
- Customers keep the plan version they bought: publishing a new version with lower limits only
  affects new subscribers.
- `GET /api/me/entitlements` returns `{ plan, features: { key: bool }, limits: { key: { name, limit, used, resetsAt? } } }`
  for the UI. `used` is `null` for a limit nothing counts; `resetsAt` is set for monthly (metered) limits.

The **Workspace** tab is a small demo of the product itself (`server/workspace.js`): projects count
against the `projects` limit, a custom domain needs the `custom_domain` feature, and calls to the
public API count against `api_calls_monthly`.

## Metered usage & the public API
Some limits aren't about how many things exist but how much is used in a month, like API calls.

```js
registerMeter('api_calls_monthly');
await consume(req, 'api_calls_monthly'); // records 1, or throws a 429 if this month's limit is used up
```

- `consume` checks and records in **one atomic SQL statement** (an upsert on `usage_counters` that
  only applies while under the limit), so concurrent calls can't go over it. A refused call records nothing.
- Usage counts per **calendar month in India time** and starts again from zero on the 1st (a new
  `usage_counters` row; old rows are the history). Not per billing period: a yearly plan's
  "API calls / month" still resets monthly, and changing plans mid-month changes the limit but keeps
  what was used, so cancelling and resubscribing doesn't reset it either.

**API keys** (`server/apikeys.js`, Workspace → API): owners and admins create keys for their own code.
A key (`sk_` + 32 random bytes) is shown once; only its SHA-256 hash and last 4 characters are stored.
Up to 10 active keys per workspace; revoking takes effect on the next request.

**Public API** (`/api/v1`): `Authorization: Bearer sk_...`. Every authenticated call counts, and plan
limits apply exactly as in the app (e.g. `POST /api/v1/projects` still respects the `projects` limit).
Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` (`-1` = unlimited) and `X-RateLimit-Reset`
(unix time of the next 1st). Once the month's calls are used up: `429` with `Retry-After` and
`{ code: 'quota_exceeded', limit, used, resetsAt, upgradeTo }`.

```bash
curl http://localhost:5000/api/v1/projects -H "Authorization: Bearer sk_..."
curl -X POST http://localhost:5000/api/v1/projects -H "Authorization: Bearer sk_..."      -H "Content-Type: application/json" -d '{"name":"From my server"}'
```

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
- A monthly quota isn't burst protection: add a per-second rate limit on `/api/v1` too.
- Cache entitlements briefly (each API call reads the plan) once traffic grows.
- Add-ons (e.g. "+5 members for ₹199/month"): recurring extras need a billing decision for autopay
  (Razorpay subscriptions have one fixed amount). Per-workspace overrides cover negotiated deals meanwhile.
- Test plan changes on autopay against real Razorpay test mode, with both a card and a UPI mandate:
  Razorpay may refuse to update some mandates, and the app then asks the customer to switch to manual.
- Watch the logs for `refund it by hand`: a payment that arrived for a checkout the customer had
  already replaced (e.g. paid in two tabs). The money is recorded on the invoice but not applied.
- Set `CLIENT_ORIGIN` to the real app URL: payment links send the customer back there after paying.
- Enable auto-capture in Dashboard → Payment Capture (otherwise `authorized` payments must be captured via API).
- Switch to `rzp_live_` keys only on the server's environment; never ship the secret to the browser.
