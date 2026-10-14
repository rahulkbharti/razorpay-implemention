# Razorpay — Node.js (Express 5) + React 19 (Vite)

## Flow
1. React asks the server to create an order (`POST /api/orders`) — the **server** decides the price.
2. React opens Razorpay Checkout with the returned `order_id`.
3. On success, Checkout returns `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`.
4. React sends those to `POST /api/payments/verify`; the server checks the HMAC-SHA256
   signature (`order_id|payment_id` signed with your key secret) and re-fetches the payment from Razorpay.
5. Webhook `POST /api/webhooks/razorpay` is the source of truth for fulfilment (covers closed tabs, network drops).

## Subscriptions (recurring payments)
Plans live in `PLANS` in `server/index.js` (Basic/Pro, monthly/yearly). On the first subscribe the
server creates them in Razorpay, tagged with `notes.key`, and reuses them after that. Razorpay plans
can't be edited, so changing a price creates a new plan and existing subscribers stay on the old one.

1. React calls `POST /api/subscriptions` with a `planKey`; the server creates a subscription
   (`total_count` = max number of charges) and returns its `subscription_id`.
2. React opens Checkout with `subscription_id` (no amount or order). The customer authorises a
   mandate (card / UPI Autopay / e-mandate) and pays the first cycle.
3. Checkout returns `razorpay_payment_id`, `razorpay_subscription_id`, `razorpay_signature`.
   `POST /api/subscriptions/verify` checks the signature. **Note the order:** `payment_id|subscription_id`.
4. From then on **Razorpay charges the customer every cycle by itself**, with nobody on your site.
   You only hear about renewals through webhooks (`subscription.charged` each cycle,
   `subscription.pending` / `subscription.halted` when charges fail, `subscription.cancelled`, `subscription.completed`).
5. `GET /api/subscriptions/:id` returns live status and the invoices (one per billing cycle).
   `POST /api/subscriptions/:id/cancel` cancels: `{ atCycleEnd: true }` stops renewal but keeps access until the paid period ends.

Status lifecycle: `created` → `authenticated` (mandate set up) → `active` (charged) → `pending`
(renewal failed, Razorpay retries) → `halted` (retries exhausted). It ends as `cancelled`, `completed` or `expired`.

The demo has no login, so the browser stores its subscription id in `localStorage`.

## Run
```bash
# backend
cd server
cp .env.example .env      # put your keys in .env
npm install
npm run dev               # http://localhost:5000

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
- Replace the in-memory `orders` / `subscriptions` Maps with a database.
- Tie each subscription to a logged-in user; only let that user view or cancel it (the demo trusts the id).
- Make webhook handling idempotent (store processed event/payment ids) — `subscription.charged` can be redelivered.
- Plan upgrades/downgrades: `razorpay.subscriptions.update(id, { plan_id, schedule_change_at })`.
  Free trials: pass `start_at` (a future timestamp) when creating the subscription.
- Enable auto-capture in Dashboard → Payment Capture (otherwise `authorized` payments must be captured via API).
- Switch to `rzp_live_` keys only on the server's environment; never ship the secret to the browser.
