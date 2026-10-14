// A workspace's plan and subscription. Our subscriptions table is the source of truth for
// access; for autopay, Razorpay webhooks keep it in sync with Razorpay's subscription.
import express from 'express';
import { query } from './db.js';
import { findSellablePrice, listFeatures, productId, resolveEntitlements, saveRazorpayPlanId } from './catalog.js';
import { requireRole, requireUser } from './auth.js';
import { razorpay, signedByRazorpay } from './razorpay.js';
import { HttpError, toId } from './util.js';

// How many times an autopay subscription charges before it completes (10 years ≈ "until cancelled").
const TOTAL_COUNT = { monthly: 120, yearly: 10 };

// Razorpay's subscription status → ours. 'authenticated' means the mandate is set up and the
// first charge is settling, which is enough to give access.
const FROM_RAZORPAY = {
  created: 'incomplete',
  authenticated: 'active',
  active: 'active',
  pending: 'past_due', // a renewal failed; Razorpay retries it
  halted: 'halted', // every retry failed
  paused: 'halted',
  cancelled: 'cancelled',
  completed: 'expired',
  expired: 'expired',
};

// Statuses that give the workspace its plan's features. Anything else means the default (free) plan.
const ACCESS = ['active', 'past_due'];

/* ---------- Current plan ---------- */

/** The plan a workspace's features come from: its paid plan version, or the product's default plan. */
export async function currentPlan(tenantId) {
  const [features, { rows }] = await Promise.all([
    listFeatures(),
    query(
      `SELECT p.key, p.name, p.version, p.entitlements, true AS paid
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.tenant_id = $1 AND s.status IN ('active', 'past_due')
       UNION ALL
       SELECT p.key, p.name, p.version, p.entitlements, false
       FROM plans p JOIN products pr ON pr.id = p.product_id AND p.key = pr.default_plan_key
       WHERE pr.id = $2 AND p.status = 'active'
       ORDER BY paid DESC
       LIMIT 1`,
      [tenantId, productId]
    ),
  ]);
  const plan = rows[0];
  if (!plan) return null; // no default plan is live, so nothing is granted
  return {
    key: plan.key,
    name: plan.name,
    version: plan.version,
    paid: plan.paid,
    features: resolveEntitlements(plan.entitlements, features),
  };
}

/* ---------- Subscriptions ---------- */

const SUBSCRIPTION = `
  SELECT s.*, p.key AS plan_key, p.name AS plan_name, p.version AS plan_version, pp.period, pp.amount, pp.currency
  FROM subscriptions s
  JOIN plans p ON p.id = s.plan_id
  JOIN plan_prices pp ON pp.id = s.price_id`;

async function getSubscription(id) {
  const { rows } = await query(`${SUBSCRIPTION} WHERE s.id = $1`, [id]);
  return rows[0];
}

async function liveSubscription(tenantId) {
  const { rows } = await query(`${SUBSCRIPTION} WHERE s.tenant_id = $1 AND s.status IN ('active', 'past_due')`, [
    tenantId,
  ]);
  return rows[0] ?? null;
}

// Shape a subscription (+ its invoices, one per billing cycle) for the client.
async function subscriptionView(s) {
  const { items: invoices } = s.razorpay_subscription_id
    ? await razorpay.invoices.all({ subscription_id: s.razorpay_subscription_id })
    : { items: [] };

  return {
    id: s.id,
    status: s.status,
    collectionMethod: s.collection_method,
    planKey: s.plan_key,
    name: s.plan_name,
    planVersion: s.plan_version,
    period: s.period,
    amount: s.amount,
    currentPeriodEnd: s.current_period_end,
    cancelAtPeriodEnd: s.cancel_at_period_end,
    endedAt: s.ended_at,
    payments: invoices.map((inv) => ({
      invoiceId: inv.id,
      paymentId: inv.payment_id,
      amount: inv.amount,
      status: inv.status,
      date: fromUnix(inv.paid_at ?? inv.billing_start ?? inv.created_at),
    })),
  };
}

const fromUnix = (seconds) => (seconds ? new Date(seconds * 1000) : null);

// Razorpay SDK errors carry the reason in err.error.description.
const razorpayError = (fallback) => (err) => {
  console.error(err);
  throw new HttpError(502, err?.error?.description || fallback);
};

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

// Before a new subscription starts, cancel the workspace's unfinished checkouts and halted
// autopay subscriptions at Razorpay, so none of them can come back to life next to it.
async function clearStale(tenantId) {
  const { rows } = await query(
    `SELECT id, status, razorpay_subscription_id FROM subscriptions
     WHERE tenant_id = $1 AND status IN ('incomplete', 'halted')`,
    [tenantId]
  );
  for (const s of rows) {
    const cancelled = await razorpay.subscriptions.cancel(s.razorpay_subscription_id, false).then(
      () => true,
      (err) => {
        console.warn(`Could not cancel ${s.razorpay_subscription_id}:`, err?.error?.description ?? err.message);
        return false;
      }
    );
    // An unfinished checkout gave no access and has no invoices, so it isn't worth keeping —
    // unless Razorpay refused to cancel it: then keep the row so a late payment still lands.
    if (s.status === 'incomplete' && cancelled) await query('DELETE FROM subscriptions WHERE id = $1', [s.id]);
    if (s.status === 'halted') {
      await query(`UPDATE subscriptions SET status = 'cancelled', ended_at = now(), updated_at = now() WHERE id = $1`, [
        s.id,
      ]);
    }
  }
}

/** Copies a Razorpay subscription's state onto our row. */
async function applyRazorpaySubscription(sub) {
  const status = FROM_RAZORPAY[sub.status] ?? 'incomplete';
  const ended = status === 'cancelled' || status === 'expired';
  try {
    await query(
      `UPDATE subscriptions
       SET status = $2,
           current_period_start = COALESCE(to_timestamp($3), current_period_start),
           current_period_end = COALESCE(to_timestamp($4), current_period_end),
           ended_at = CASE WHEN $5 THEN COALESCE(ended_at, to_timestamp($6), now()) END,
           cancel_at_period_end = cancel_at_period_end AND NOT $5,
           updated_at = now()
       WHERE razorpay_subscription_id = $1`,
      [sub.id, status, sub.current_start ?? null, sub.current_end ?? null, ended, sub.ended_at ?? null]
    );
  } catch (err) {
    if (err.code !== '23505') throw err;
    // Only possible if two checkouts were paid at once (e.g. in two tabs).
    console.error(`Razorpay ${sub.id} is ${sub.status}, but its workspace already has a live subscription — refund one by hand`);
  }
}

/**
 * For every subscription.* webhook. Re-reads the subscription from Razorpay instead of trusting
 * the payload, so an event that arrives late or twice can't roll the status back.
 */
export async function syncRazorpaySubscription(razorpaySubscriptionId) {
  const { rows } = await query('SELECT 1 FROM subscriptions WHERE razorpay_subscription_id = $1', [
    razorpaySubscriptionId,
  ]);
  if (!rows[0]) return console.warn(`[webhook] ignoring ${razorpaySubscriptionId}: not one of ours`);
  const sub = await razorpay.subscriptions.fetch(razorpaySubscriptionId);
  await applyRazorpaySubscription(sub);
  console.log(`[webhook] ${sub.id} is ${sub.status}`);
}

/* ---------- Admin view ---------- */

/** Every workspace with its owner and latest subscription. */
export async function listTenants() {
  const { rows } = await query(
    `SELECT t.id, t.name, t.created_at, o.email, o.phone,
            s.status, s.collection_method, s.current_period_end, s.cancel_at_period_end,
            CASE WHEN s.status IN ('active', 'past_due') THEN p.key || ' v' || p.version
                 ELSE (SELECT default_plan_key FROM products WHERE id = $1) END AS plan
     FROM tenants t
     LEFT JOIN LATERAL (
       SELECT u.email, u.phone FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = t.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1
     ) o ON true
     LEFT JOIN LATERAL (
       SELECT * FROM subscriptions WHERE tenant_id = t.id AND status <> 'incomplete' ORDER BY created_at DESC LIMIT 1
     ) s ON true
     LEFT JOIN plans p ON p.id = s.plan_id
     WHERE t.product_id = $1
     ORDER BY t.created_at DESC
     LIMIT 500`,
    [productId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    ownerEmail: r.email,
    ownerPhone: r.phone,
    plan: r.plan,
    subscription: r.status && {
      status: r.status,
      collectionMethod: r.collection_method,
      currentPeriodEnd: r.current_period_end,
      cancelAtPeriodEnd: r.cancel_at_period_end,
    },
  }));
}

/* ---------- Routes ---------- */

export function billingRouter() {
  const router = express.Router();

  router.get('/me', requireUser, async (req, res) => {
    res.json({ user: req.user, tenant: req.tenant, plan: await currentPlan(req.tenant.id) });
  });

  // The workspace's latest subscription, live or ended (null if it never had one).
  router.get('/subscription', requireUser, async (req, res) => {
    const { rows } = await query(
      `${SUBSCRIPTION} WHERE s.tenant_id = $1 AND s.status <> 'incomplete' ORDER BY s.created_at DESC LIMIT 1`,
      [req.tenant.id]
    );
    let s = rows[0];
    // Webhooks are how we normally hear about renewals and cancellations; re-reading here keeps
    // this right when they're late or not set up at all (e.g. running locally without a tunnel).
    if (s?.razorpay_subscription_id && !['cancelled', 'expired'].includes(s.status)) {
      await applyRazorpaySubscription(
        await razorpay.subscriptions.fetch(s.razorpay_subscription_id).catch(razorpayError('Could not fetch subscription'))
      );
      s = await getSubscription(s.id);
    }
    res.json({ subscription: s ? await subscriptionView(s) : null });
  });

  // Autopay. Flow: create a Razorpay subscription → Checkout with its id (the customer authorises
  // the mandate and pays the first cycle) → verify → Razorpay charges every later cycle itself.
  router.post('/subscriptions', requireUser, requireRole('owner', 'admin'), async (req, res) => {
    const priceId = toId(req.body?.priceId);
    const price = priceId && (await findSellablePrice(priceId));
    if (!price) throw new HttpError(400, 'Unknown plan');
    if (await liveSubscription(req.tenant.id)) {
      throw new HttpError(409, 'This workspace already has an active subscription — cancel it first');
    }
    await clearStale(req.tenant.id);

    const planId = await razorpayPlanFor(price).catch(razorpayError('Could not create the Razorpay plan'));
    const sub = await razorpay.subscriptions
      .create({
        plan_id: planId,
        total_count: TOTAL_COUNT[price.period],
        customer_notify: 1, // Razorpay emails/SMSes the customer about charges
        notes: { tenantId: String(req.tenant.id), priceId: String(price.id), planKey: price.planKey },
      })
      .catch(razorpayError('Could not create subscription'));

    await query(
      `INSERT INTO subscriptions (tenant_id, plan_id, price_id, collection_method, razorpay_subscription_id)
       VALUES ($1, $2, $3, 'auto', $4)`,
      [req.tenant.id, price.planId, price.id, sub.id]
    );
    res.json({ subscriptionId: sub.id, name: price.planName, amount: price.amount, period: price.period });
  });

  router.post('/subscriptions/verify', requireUser, async (req, res) => {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body ?? {};
    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      throw new HttpError(400, 'Missing fields');
    }
    // Note the order: payment_id|subscription_id (one-time orders sign order_id|payment_id).
    if (!signedByRazorpay(`${razorpay_payment_id}|${razorpay_subscription_id}`, razorpay_signature)) {
      throw new HttpError(400, 'Invalid signature');
    }
    const { rows } = await query('SELECT id FROM subscriptions WHERE razorpay_subscription_id = $1 AND tenant_id = $2', [
      razorpay_subscription_id,
      req.tenant.id,
    ]);
    if (!rows[0]) throw new HttpError(404, 'Subscription not found');

    const sub = await razorpay.subscriptions
      .fetch(razorpay_subscription_id)
      .catch(razorpayError('Could not fetch subscription'));
    await applyRazorpaySubscription(sub);
    const status = FROM_RAZORPAY[sub.status];
    if (!ACCESS.includes(status)) throw new HttpError(400, `Subscription is ${sub.status}`);
    res.json({ verified: true, status });
  });

  router.post('/subscription/cancel', requireUser, requireRole('owner', 'admin'), async (req, res) => {
    const live = await liveSubscription(req.tenant.id);
    if (!live) throw new HttpError(404, 'No active subscription to cancel');
    // true: stop renewing but keep access until the paid period ends. false: end it now.
    const atCycleEnd = Boolean(req.body?.atCycleEnd);

    const sub = await razorpay.subscriptions
      .cancel(live.razorpay_subscription_id, atCycleEnd)
      .catch(razorpayError('Could not cancel subscription'));
    // Razorpay keeps the status 'active' until the cycle ends and has no field for
    // "cancel scheduled", so remember it ourselves.
    if (atCycleEnd) await query('UPDATE subscriptions SET cancel_at_period_end = true WHERE id = $1', [live.id]);
    await applyRazorpaySubscription(sub);
    res.json({ subscription: await subscriptionView(await getSubscription(live.id)) });
  });

  return router;
}
