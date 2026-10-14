import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import Razorpay from 'razorpay';

const {
  PORT = 5000,
  CLIENT_ORIGIN = 'http://localhost:5173',
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
} = process.env;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.error('Missing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in .env');
  process.exit(1);
}

const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });

// Prices live on the server — never trust an amount sent by the browser.
// Amounts are in paise (₹1 = 100 paise).
const PRODUCTS = {
  basic: { name: 'Basic Plan', amount: 49900 },
  pro: { name: 'Pro Plan', amount: 99900 },
};

// Replace with your database (orders table keyed by razorpay order id).
const orders = new Map();

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));

/* ---------- Webhook (needs the RAW body, so register before express.json) ---------- */
app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json' }), (req, res) => {
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
      break;
  }

  res.json({ received: true });
});

app.use(express.json());

/* ---------- Public config ---------- */
app.get('/api/config', (_req, res) => {
  res.json({ keyId: RAZORPAY_KEY_ID, products: PRODUCTS });
});

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

  const expected = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (!safeEqual(expected, razorpay_signature)) {
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

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
