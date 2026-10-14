# Razorpay — Node.js (Express 5) + React 19 (Vite)

## Flow
1. React asks the server to create an order (`POST /api/orders`) — the **server** decides the price.
2. React opens Razorpay Checkout with the returned `order_id`.
3. On success, Checkout returns `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`.
4. React sends those to `POST /api/payments/verify`; the server checks the HMAC-SHA256
   signature (`order_id|payment_id` signed with your key secret) and re-fetches the payment from Razorpay.
5. Webhook `POST /api/webhooks/razorpay` is the source of truth for fulfilment (covers closed tabs, network drops).

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

## Webhooks locally
Expose port 5000 (e.g. `ngrok http 5000`), then in Dashboard → Webhooks add
`https://<your-tunnel>/api/webhooks/razorpay`, set a secret (same as `RAZORPAY_WEBHOOK_SECRET`)
and subscribe to `payment.captured`, `payment.failed`, `order.paid`.

## Production checklist
- Replace the in-memory `orders` Map with a database.
- Make webhook handling idempotent (store processed event/payment ids).
- Enable auto-capture in Dashboard → Payment Capture (otherwise `authorized` payments must be captured via API).
- Switch to `rzp_live_` keys only on the server's environment; never ship the secret to the browser.
