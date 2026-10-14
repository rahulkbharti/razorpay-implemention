import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { razorpay, keyId, signedByRazorpay } from './razorpay.js';
import { migrate } from './db.js';
import { initCatalog, listPublicPlans } from './catalog.js';
import { adminRouter } from './admin.js';
import { authRouter, loadSession } from './auth.js';
import { billingRouter, syncRazorpaySubscription } from './billing.js';
import { HttpError, safeEqual } from './util.js';

const {
  PORT = 5000,
  CLIENT_ORIGIN = 'http://localhost:5173',
  RAZORPAY_WEBHOOK_SECRET,
  DATABASE_URL,
  ADMIN_TOKEN,
} = process.env;

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL in .env');
  process.exit(1);
}

// Prices live on the server — never trust an amount sent by the browser.
// Amounts are in paise (₹1 = 100 paise).
const PRODUCTS = {
  basic: { name: 'Basic Plan', amount: 49900 },
  pro: { name: 'Pro Plan', amount: 99900 },
};

// Replace with your database (orders table keyed by razorpay order id).
const orders = new Map();

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));

/* ---------- Webhook (needs the RAW body, so register before express.json) ---------- */
app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.get('x-razorpay-signature');
  if (!RAZORPAY_WEBHOOK_SECRET || !signature) return res.status(400).send('Bad request');

  const expected = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    .update(req.body) // Buffer
    .digest('hex');

  if (!safeEqual(expected, signature)) return res.status(400).send('Invalid signature');

  const event = JSON.parse(req.body.toString('utf8'));
  const payment = event.payload?.payment?.entity;

  switch (event.event) {
    case 'payment.captured':
    case 'order.paid': {
      const order = orders.get(payment?.order_id);
      if (order && order.status !== 'paid') {
        order.status = 'paid';
        order.paymentId = payment.id;
        // fulfil the order here (idempotently — Razorpay may resend events)
      }
      break;
    }
    case 'payment.failed':
      console.warn('Payment failed:', payment?.id, payment?.error_description);
      break;
    default:
      // Recurring charges happen on Razorpay's schedule, with nobody on your site, so the
      // webhook is the only place you learn about renewals, failed retries and cancellations.
      // If syncing throws, the 500 makes Razorpay retry the event later.
      if (event.event.startsWith('subscription.')) {
        await syncRazorpaySubscription(event.payload.subscription.entity.id);
      }
      break;
  }

  res.json({ received: true });
});

app.use(express.json());
app.use('/api', loadSession);

/* ---------- Public config ---------- */
app.get('/api/config', async (_req, res) => {
  res.json({ keyId, products: PRODUCTS, plans: await listPublicPlans() });
});

app.use('/api/auth', authRouter());
app.use('/api/admin', adminRouter(ADMIN_TOKEN));
app.use('/api', billingRouter());

/* ---------- 1. Create order ---------- */
app.post('/api/orders', async (req, res) => {
  const product = PRODUCTS[req.body?.productId];
  if (!product) return res.status(400).json({ error: 'Unknown product' });

  try {
    const order = await razorpay.orders.create({
      amount: product.amount,
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`,
      notes: { productId: req.body.productId },
    });

    orders.set(order.id, { productId: req.body.productId, amount: order.amount, status: 'created' });

    res.json({ orderId: order.id, amount: order.amount, currency: order.currency, name: product.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.error?.description || 'Could not create order' });
  }
});

/* ---------- 2. Verify payment after Checkout succeeds ---------- */
app.post('/api/payments/verify', async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body ?? {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ verified: false, error: 'Missing fields' });
  }

  if (!signedByRazorpay(`${razorpay_order_id}|${razorpay_payment_id}`, razorpay_signature)) {
    return res.status(400).json({ verified: false, error: 'Invalid signature' });
  }

  let order = orders.get(razorpay_order_id);

  try {
    // The in-memory Map is wiped on every restart (`node --watch` restarts on save),
    // so fall back to the order Razorpay has on record. The signature above proves it is ours.
    if (!order) {
      const rzpOrder = await razorpay.orders.fetch(razorpay_order_id);
      order = { productId: rzpOrder.notes?.productId, amount: rzpOrder.amount, status: 'created' };
      orders.set(razorpay_order_id, order);
    }

    // Extra check straight from Razorpay: right order, right amount, money actually taken.
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    const ok =
      payment.order_id === razorpay_order_id &&
      payment.amount === order.amount &&
      ['authorized', 'captured'].includes(payment.status);

    if (!ok) return res.status(400).json({ verified: false, error: 'Payment mismatch' });

    order.status = 'paid';
    order.paymentId = razorpay_payment_id;
    res.json({ verified: true, paymentId: razorpay_payment_id, orderId: razorpay_order_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ verified: false, error: 'Could not fetch payment' });
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Express 5 passes errors thrown in async handlers here.
app.use((err, _req, res, _next) => {
  if (err.code === '23505') return res.status(409).json({ error: 'That key is already taken' }); // unique violation
  const status = err.status ?? 500; // HttpError, or a 400 from express.json for a malformed body
  const expose = err instanceof HttpError || status < 500;
  if (!expose) console.error(err);
  res.status(status).json({ error: expose ? err.message : 'Something went wrong' });
});

try {
  await migrate();
  await initCatalog();
} catch (err) {
  console.error('Could not set up the database:', err.message);
  process.exit(1);
}

// Express 5 passes a startup error (e.g. port already in use) to this callback instead of throwing.
app.listen(PORT, (err) => {
  if (err) {
    console.error(`Could not start on port ${PORT}:`, err.message);
    process.exit(1);
  }
  console.log(`API running on http://localhost:${PORT}`);
});
