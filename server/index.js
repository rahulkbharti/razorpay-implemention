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

// Recurring plans. totalCount = how many times the customer is charged before the
// subscription completes (120 months / 10 years ≈ "until cancelled").
const PLANS = {
  basic_monthly: { name: 'Basic', period: 'monthly', amount: 49900, totalCount: 120 },
  pro_monthly: { name: 'Pro', period: 'monthly', amount: 99900, totalCount: 120 },
  basic_yearly: { name: 'Basic', period: 'yearly', amount: 499000, totalCount: 10 },
  pro_yearly: { name: 'Pro', period: 'yearly', amount: 999000, totalCount: 10 },
};

// Replace with your database (orders table keyed by razorpay order id).
const orders = new Map();
// Replace with your database (subscriptions table, linked to your user).
const subscriptions = new Map();

// Razorpay plans can't be edited or deleted, so instead of creating one per restart we
// tag each with notes.key and reuse the one whose key, price and period still match.
// Changing a price in PLANS creates a new plan; existing subscribers stay on the old one.
let planIds;
function getPlanId(key) {
  planIds ??= syncPlans().catch((err) => {
    planIds = undefined; // retry on the next request
    throw err;
  });
  return planIds.then((ids) => ids[key]);
}

async function syncPlans() {
  const { items } = await razorpay.plans.all({ count: 100 });
  const ids = {};
  for (const [key, p] of Object.entries(PLANS)) {
    const existing = items.find(
      (rp) => rp.notes?.key === key && rp.item.amount === p.amount && rp.period === p.period && rp.interval === 1
    );
    ids[key] =
      existing?.id ??
      (
        await razorpay.plans.create({
          period: p.period,
          interval: 1,
          item: { name: `${p.name} (${p.period})`, amount: p.amount, currency: 'INR' },
          notes: { key },
        })
      ).id;
  }
  return ids;
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
app.get('/api/config', (_req, res) => {
  res.json({ keyId: RAZORPAY_KEY_ID, products: PRODUCTS, plans: PLANS });
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

/* ---------- Subscriptions (recurring payments) ---------- */
// Flow: create subscription → Checkout with subscription_id (customer authorises the
// mandate and pays the first cycle) → verify → Razorpay charges every later cycle itself.
//
// No login in this demo, so anyone holding a subscription id can view or cancel it.
// In a real app, look the subscription up from the logged-in user instead.
const SUB_ID = /^sub_[A-Za-z0-9]+$/; // ids go into Razorpay API URLs, so only allow real ones

app.post('/api/subscriptions', async (req, res) => {
  const planKey = req.body?.planKey;
  const plan = PLANS[planKey];
  if (!plan) return res.status(400).json({ error: 'Unknown plan' });

  try {
    const sub = await razorpay.subscriptions.create({
      plan_id: await getPlanId(planKey),
      total_count: plan.totalCount,
      customer_notify: 1, // Razorpay emails/SMSes the customer about charges
      notes: { planKey },
    });

    subscriptions.set(sub.id, { planKey, status: sub.status });
    res.json({ subscriptionId: sub.id, name: plan.name, amount: plan.amount, period: plan.period });
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
    const planKey = sub.notes?.planKey;
    // 'authenticated' = mandate set up, first charge still settling; 'active' = charged.
    if (!PLANS[planKey] || !['authenticated', 'active'].includes(sub.status)) {
      return res.status(400).json({ verified: false, error: `Subscription is ${sub.status}` });
    }

    subscriptions.set(sub.id, { ...subscriptions.get(sub.id), planKey, status: sub.status });
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
  const planKey = sub.notes?.planKey;
  const plan = PLANS[planKey] ?? {};
  const { items: invoices } = await razorpay.invoices.all({ subscription_id: sub.id });

  return {
    id: sub.id,
    status: sub.status,
    planKey,
    name: plan.name,
    period: plan.period,
    amount: plan.amount,
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

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
