import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import Razorpay from 'razorpay';
import { migrate } from './db.js';
import {
  initCatalog,
  listPublicPlans,
  findSellablePrice,
  findPriceByRazorpayPlan,
  saveRazorpayPlanId,
} from './catalog.js';
import { adminRouter } from './admin.js';
import { safeEqual, toId } from './util.js';

const {
  PORT = 5000,
  CLIENT_ORIGIN = 'http://localhost:5173',
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,
  DATABASE_URL,
  ADMIN_TOKEN,
} = process.env;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.error('Missing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in .env');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL in .env');
  process.exit(1);
}

const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });

// Prices live on the server — never trust an amount sent by the browser.
// Amounts are in paise (₹1 = 100 paise).
const PRODUCTS = {
  basic: { name: 'Basic Plan', amount: 49900 },
  pro: { name: 'Pro Plan', amount: 99900 },
};

// Plans, their features and their prices live in the database (see catalog.js) and are
// managed from the Admin tab.

// How many times a subscription charges before it completes (10 years ≈ "until cancelled").
const TOTAL_COUNT = { monthly: 120, yearly: 10 };

// Replace with your database (orders table keyed by razorpay order id).
const orders = new Map();
// Replace with your database (subscriptions table, linked to your user).
const subscriptions = new Map();

// Each price gets its own Razorpay plan the first time someone subscribes to it. Razorpay
// plans can't be edited, which is why a price row never changes once it has one.
async function razorpayPlanFor(price) {
  if (price.razorpayPlanId) return price.razorpayPlanId;
  const plan = await razorpay.plans.create({
    period: price.period,
    interval: 1,
    item: { name: `${price.planName} v${price.planVersion} (${price.period})`, amount: price.amount, currency: price.currency },
    notes: { priceId: String(price.id), planKey: price.planKey },
  });
  // Two first subscribes at the same moment can both get here; the first save wins and
  // the other Razorpay plan is never used.
  return saveRazorpayPlanId(price.id, plan.id);
}

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
      if (event.event.startsWith('subscription.')) onSubscriptionEvent(event.event, event.payload);
      break;
  }

  res.json({ received: true });
});

// Recurring charges happen on Razorpay's schedule, with nobody on your site, so the
// webhook is the only place you learn about renewals, failed retries and cancellations.
function onSubscriptionEvent(name, payload) {
  const sub = payload.subscription.entity;
  const record = subscriptions.get(sub.id) ?? { planKey: sub.notes?.planKey };
  record.status = sub.status;
  record.paidCount = sub.paid_count;

  // subscription.charged fires once per billing cycle (and may be redelivered):
  // record each payment once, keyed by payment id, then extend the user's access.
  if (name === 'subscription.charged') record.lastPaymentId = payload.payment?.entity?.id;

  // Give access while status is 'active'; take it away on 'halted', 'cancelled' and 'completed'.
  subscriptions.set(sub.id, record);
  console.log(`[webhook] ${name}: ${sub.id} is ${sub.status} (${sub.paid_count}/${sub.total_count} paid)`);
}

app.use(express.json());

/* ---------- Public config ---------- */
app.get('/api/config', async (_req, res) => {
  res.json({ keyId: RAZORPAY_KEY_ID, products: PRODUCTS, plans: await listPublicPlans() });
});

app.use('/api/admin', adminRouter(ADMIN_TOKEN));

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

/* ---------- Subscriptions (recurring payments) ---------- */
// Flow: create subscription → Checkout with subscription_id (customer authorises the
// mandate and pays the first cycle) → verify → Razorpay charges every later cycle itself.
//
// No login in this demo, so anyone holding a subscription id can view or cancel it.
// In a real app, look the subscription up from the logged-in user instead.
const SUB_ID = /^sub_[A-Za-z0-9]+$/; // ids go into Razorpay API URLs, so only allow real ones

app.post('/api/subscriptions', async (req, res) => {
  const priceId = toId(req.body?.priceId);
  const price = priceId && (await findSellablePrice(priceId));
  if (!price) return res.status(400).json({ error: 'Unknown plan' });

  try {
    const sub = await razorpay.subscriptions.create({
      plan_id: await razorpayPlanFor(price),
      total_count: TOTAL_COUNT[price.period],
      customer_notify: 1, // Razorpay emails/SMSes the customer about charges
      notes: { planKey: price.planKey, priceId: String(price.id) },
    });

    subscriptions.set(sub.id, { planKey: price.planKey, status: sub.status });
    res.json({ subscriptionId: sub.id, name: price.planName, amount: price.amount, period: price.period });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.error?.description || 'Could not create subscription' });
  }
});

app.post('/api/subscriptions/verify', async (req, res) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body ?? {};
  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
    return res.status(400).json({ verified: false, error: 'Missing fields' });
  }

  // Note the order: payment_id|subscription_id (one-time orders sign order_id|payment_id).
  const expected = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
    .digest('hex');

  if (!safeEqual(expected, razorpay_signature)) {
    return res.status(400).json({ verified: false, error: 'Invalid signature' });
  }

  try {
    const sub = await razorpay.subscriptions.fetch(razorpay_subscription_id);
    const price = await findPriceByRazorpayPlan(sub.plan_id);
    if (!price) return res.status(400).json({ verified: false, error: 'Subscription is not for one of our plans' });
    // 'authenticated' = mandate set up, first charge still settling; 'active' = charged.
    if (!['authenticated', 'active'].includes(sub.status)) {
      return res.status(400).json({ verified: false, error: `Subscription is ${sub.status}` });
    }

    subscriptions.set(sub.id, { ...subscriptions.get(sub.id), planKey: price.planKey, status: sub.status });
    res.json({ verified: true, subscriptionId: sub.id, status: sub.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ verified: false, error: 'Could not fetch subscription' });
  }
});

app.get('/api/subscriptions/:id', async (req, res) => {
  if (!SUB_ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid subscription id' });

  try {
    const sub = await razorpay.subscriptions.fetch(req.params.id);
    res.json(await subscriptionView(sub));
  } catch (err) {
    if (err?.statusCode === 400) return res.status(404).json({ error: 'Subscription not found' });
    console.error(err);
    res.status(500).json({ error: 'Could not fetch subscription' });
  }
});

app.post('/api/subscriptions/:id/cancel', async (req, res) => {
  if (!SUB_ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid subscription id' });
  // true: stop renewing but keep access until the paid period ends. false: end it now.
  const atCycleEnd = Boolean(req.body?.atCycleEnd);

  try {
    const sub = await razorpay.subscriptions.cancel(req.params.id, atCycleEnd);
    // Razorpay keeps the status 'active' until the cycle ends and has no field for
    // "cancel scheduled", so remember it ourselves.
    subscriptions.set(sub.id, { ...subscriptions.get(sub.id), status: sub.status, cancelAtCycleEnd: atCycleEnd });
    res.json(await subscriptionView(sub));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.error?.description || 'Could not cancel subscription' });
  }
});

// Shape a Razorpay subscription (+ its invoices, one per billing cycle) for the client.
async function subscriptionView(sub) {
  const [price, { items: invoices }] = await Promise.all([
    priceOf(sub),
    razorpay.invoices.all({ subscription_id: sub.id }),
  ]);

  return {
    id: sub.id,
    status: sub.status,
    planKey: price.planKey,
    priceId: price.id,
    name: price.planName,
    period: price.period,
    amount: price.amount,
    paidCount: sub.paid_count,
    totalCount: sub.total_count,
    currentEnd: sub.current_end,
    chargeAt: sub.charge_at,
    endedAt: sub.ended_at,
    cancelScheduled: sub.status === 'active' && Boolean(subscriptions.get(sub.id)?.cancelAtCycleEnd),
    payments: invoices.map((inv) => ({
      invoiceId: inv.id,
      paymentId: inv.payment_id,
      amount: inv.amount,
      status: inv.status,
      date: inv.paid_at ?? inv.billing_start ?? inv.created_at,
    })),
  };
}

// Subscriptions made before plans moved into the database have no price row, so fall back
// to what Razorpay has on record for their plan.
async function priceOf(sub) {
  const price = await findPriceByRazorpayPlan(sub.plan_id);
  if (price) return price;
  const plan = await razorpay.plans.fetch(sub.plan_id);
  return { id: null, planKey: sub.notes?.planKey, planName: plan.item.name, period: plan.period, amount: plan.item.amount };
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// Express 5 passes errors thrown in async handlers here.
app.use((err, _req, res, _next) => {
  if (err.code === '23505') return res.status(409).json({ error: 'That key is already taken' }); // unique violation
  const status = err.status ?? 500; // HttpError, or a 400 from express.json for a malformed body
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status < 500 ? err.message : 'Something went wrong' });
});

try {
  await migrate();
  await initCatalog();
} catch (err) {
  console.error('Could not set up the database:', err.message);
  process.exit(1);
}

app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
