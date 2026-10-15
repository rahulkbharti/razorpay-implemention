// A workspace's plan and subscription. Our subscriptions table is the source of truth for
// access, whichever way the money is collected:
//   auto:   a Razorpay Subscription (mandate); Razorpay webhooks keep our row in sync
//   manual: the customer pays each period themselves (see manual.js)
import express from 'express';
import { query } from './db.js';
import { findSellablePrice, listFeatures, productId, resolveEntitlements, saveRazorpayPlanId } from './catalog.js';
import { requireRole, requireUser } from './auth.js';
import { razorpay, signedByRazorpay } from './razorpay.js';
import {
  GRACE_DAYS,
  applyInvoicePayment,
  openFirstInvoice,
  runBillingJob,
  syncOpenLinks,
  voidOpenInvoices,
  voidTenantInvoices,
} from './manual.js';
import { HttpError, toId } from './util.js';

// How many times an autopay subscription charges before it completes (10 years ≈ "until cancelled").
export const TOTAL_COUNT = { monthly: 120, yearly: 10 };

// Razorpay's subscription status → ours. 'authenticated' means the mandate is set up and the
// first charge is settling (or, with a trial, scheduled for when the trial ends).
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
const ACCESS = ['trialing', 'active', 'past_due'];
const IN_ACCESS = `('trialing', 'active', 'past_due')`;

/* ---------- Current plan ---------- */

/**
 * The plan a workspace's features come from: its paid (or trial) plan version, or the product's
 * default plan, with the workspace's overrides (set by an admin) applied on top.
 */
export async function currentPlan(tenantId) {
  const [features, overrides, { rows }] = await Promise.all([
    listFeatures(),
    tenantOverrides(tenantId),
    query(
      `SELECT p.key, p.name, p.version, p.entitlements, true AS paid
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.tenant_id = $1 AND s.status IN ${IN_ACCESS}
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
    features: resolveEntitlements(plan.entitlements, features, overrides),
  };
}

export async function tenantOverrides(tenantId) {
  const { rows } = await query('SELECT overrides FROM tenants WHERE id = $1', [tenantId]);
  return rows[0]?.overrides;
}

// One free trial per workspace. A checkout that was never finished doesn't use it up.
async function trialUsed(tenantId) {
  const { rows } = await query(
    `SELECT 1 FROM subscriptions WHERE tenant_id = $1 AND trial_end IS NOT NULL AND status <> 'incomplete'`,
    [tenantId]
  );
  return rows.length > 0;
}

/* ---------- Subscriptions ---------- */

export const SUBSCRIPTION = `
  SELECT s.*, p.key AS plan_key, p.name AS plan_name, p.version AS plan_version, pp.period, pp.amount, pp.currency,
         np.name AS pending_plan_name, npp.period AS pending_period, npp.amount AS pending_amount
  FROM subscriptions s
  JOIN plans p ON p.id = s.plan_id
  JOIN plan_prices pp ON pp.id = s.price_id
  LEFT JOIN plans np ON np.id = s.pending_plan_id
  LEFT JOIN plan_prices npp ON npp.id = s.pending_price_id`;

export async function getSubscription(id) {
  const { rows } = await query(`${SUBSCRIPTION} WHERE s.id = $1`, [id]);
  return rows[0];
}

export async function liveSubscription(tenantId) {
  const { rows } = await query(`${SUBSCRIPTION} WHERE s.tenant_id = $1 AND s.status IN ${IN_ACCESS}`, [tenantId]);
  return rows[0] ?? null;
}

// Shape a subscription and its payment history for the client. Autopay cycles are invoiced by
// Razorpay; manual periods and upgrade charges are our invoices. A subscription switched between
// the two has both. An upgrade nobody paid for isn't shown: it was just an abandoned checkout.
export async function subscriptionView(s) {
  const [fromRazorpay, { rows: ours }] = await Promise.all([
    s.razorpay_subscription_id
      ? razorpay.invoices.all({ subscription_id: s.razorpay_subscription_id }).then((r) => r.items)
      : [],
    query(
      `SELECT * FROM invoices WHERE subscription_id = $1 AND status <> 'void' AND NOT (kind = 'upgrade' AND status = 'open')`,
      [s.id]
    ),
  ]);
  const payments = [
    ...fromRazorpay.map((inv) => ({
      invoiceId: inv.id,
      paymentId: inv.payment_id,
      amount: inv.amount,
      status: inv.status,
      date: fromUnix(inv.paid_at ?? inv.billing_start ?? inv.created_at),
    })),
    ...ours.map((inv) => ({
      invoiceId: inv.id,
      kind: inv.kind,
      paymentId: inv.razorpay_payment_id,
      amount: inv.amount,
      status: inv.status === 'open' ? 'issued' : inv.status,
      date: inv.paid_at ?? inv.due_at,
      dueAt: inv.due_at,
      payUrl: inv.status === 'open' ? inv.payment_link_url : null,
    })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  return {
    id: s.id,
    status: s.status,
    collectionMethod: s.collection_method,
    planKey: s.plan_key,
    priceId: s.price_id,
    name: s.plan_name,
    planVersion: s.plan_version,
    period: s.period,
    amount: s.amount,
    trialEnd: s.trial_end,
    currentPeriodEnd: s.current_period_end,
    graceEndsAt:
      s.status === 'past_due' && s.collection_method === 'manual'
        ? new Date(new Date(s.current_period_end).getTime() + GRACE_DAYS * 86400_000)
        : null,
    cancelAtPeriodEnd: s.cancel_at_period_end,
    endedAt: s.ended_at,
    pendingChange: s.pending_price_id && {
      priceId: s.pending_price_id,
      name: s.pending_plan_name,
      period: s.pending_period,
      amount: s.pending_amount,
      at: s.pending_change_at,
    },
    // The renewal the customer can pay right now (manual), from the reminder link.
    openInvoice: payments.find((p) => p.payUrl) ?? null,
    payments,
  };
}

const fromUnix = (seconds) => (seconds ? new Date(seconds * 1000) : null);

// Razorpay SDK errors carry the reason in err.error.description.
export const razorpayError = (fallback) => (err) => {
  console.error(err);
  throw new HttpError(502, err?.error?.description || fallback);
};

// Each price gets its own Razorpay plan the first time someone subscribes to it with autopay.
// Razorpay plans can't be edited, which is why a price row never changes once it has one.
export async function razorpayPlanFor(price) {
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

// Before a new subscription starts, clear out the workspace's unfinished checkouts, halted
// autopay subscriptions and unpaid invoices (e.g. the late-payment link of an expired manual
// subscription), so none of them can come back to life next to it. Razorpay orders can't be
// cancelled, so if the customer still pays a voided one, applyInvoicePayment records the money
// and flags it if it can't be applied.
async function clearStale(tenantId) {
  await voidTenantInvoices(tenantId);
  const { rows } = await query(
    `SELECT id, status, collection_method, razorpay_subscription_id FROM subscriptions
     WHERE tenant_id = $1 AND status IN ('incomplete', 'halted')`,
    [tenantId]
  );
  for (const s of rows) {
    if (s.collection_method === 'manual') continue; // nothing at Razorpay; its invoice was voided above
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

/**
 * Copies a Razorpay subscription's state onto our row. Only while the row is on autopay: after a
 * switch to manual payment, late events about the old Razorpay subscription must not touch it.
 */
export async function applyRazorpaySubscription(sub) {
  const status = FROM_RAZORPAY[sub.status] ?? 'incomplete';
  const ended = status === 'cancelled' || status === 'expired';
  try {
    await query(
      `UPDATE subscriptions
       SET status = CASE WHEN $7 = 'authenticated' AND trial_end > now() THEN 'trialing' ELSE $2 END,
           current_period_start = COALESCE(to_timestamp($3), current_period_start),
           current_period_end = COALESCE(to_timestamp($4), current_period_end),
           ended_at = CASE WHEN $5 THEN COALESCE(ended_at, to_timestamp($6), now()) END,
           cancel_at_period_end = cancel_at_period_end AND NOT $5,
           updated_at = now()
       WHERE razorpay_subscription_id = $1 AND collection_method = 'auto'`,
      [sub.id, status, sub.current_start ?? null, sub.current_end ?? null, ended, sub.ended_at ?? null, sub.status]
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
  const { rows } = await query(
    `SELECT 1 FROM subscriptions WHERE razorpay_subscription_id = $1 AND collection_method = 'auto'`,
    [razorpaySubscriptionId]
  );
  if (!rows[0]) return console.warn(`[webhook] ignoring ${razorpaySubscriptionId}: not an autopay subscription of ours`);
  const sub = await razorpay.subscriptions.fetch(razorpaySubscriptionId);
  await applyRazorpaySubscription(sub);
  console.log(`[webhook] ${sub.id} is ${sub.status}`);
}

/* ---------- Admin view ---------- */

/** Every workspace with its owner and latest subscription. */
export async function listTenants() {
  const { rows } = await query(
    `SELECT t.id, t.name, t.created_at, o.email, o.phone,
            (t.overrides->'features' <> '{}' OR t.overrides->'limits' <> '{}') AS has_overrides,
            s.status, s.collection_method, s.current_period_end, s.cancel_at_period_end,
            CASE WHEN s.status IN ${IN_ACCESS} THEN p.key || ' v' || p.version
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
    hasOverrides: r.has_overrides,
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
    const [plan, usedTrial] = await Promise.all([currentPlan(req.tenant.id), trialUsed(req.tenant.id)]);
    res.json({ user: req.user, tenant: req.tenant, plan, trialAvailable: !usedTrial });
  });

  // The workspace's latest subscription, live or ended (null if it never had one).
  router.get('/subscription', requireUser, async (req, res) => {
    const { rows } = await query(
      `${SUBSCRIPTION} WHERE s.tenant_id = $1 AND s.status <> 'incomplete' ORDER BY s.created_at DESC LIMIT 1`,
      [req.tenant.id]
    );
    let s = rows[0];
    // Webhooks are how we normally hear about payments, renewals and cancellations; re-reading
    // here keeps this right when they're late or not set up at all (e.g. locally without a tunnel).
    if (s?.collection_method === 'auto' && !['cancelled', 'expired'].includes(s.status)) {
      await applyRazorpaySubscription(
        await razorpay.subscriptions.fetch(s.razorpay_subscription_id).catch(razorpayError('Could not fetch subscription'))
      );
    } else if (s?.collection_method === 'manual') {
      await syncOpenLinks(s.id).catch(razorpayError('Could not check the payment link'));
    }
    if (s) s = await getSubscription(s.id);
    res.json({ subscription: s ? await subscriptionView(s) : null });
  });

  // Starts a subscription. method 'auto' (default): Razorpay Subscription → Checkout authorises the
  // mandate (and pays the first cycle unless there's a trial). method 'manual': a trial starts right
  // away, or the first period is paid in Checkout with an order.
  router.post('/subscriptions', requireUser, requireRole('owner', 'admin'), async (req, res) => {
    const priceId = toId(req.body?.priceId);
    const method = req.body?.method === 'manual' ? 'manual' : 'auto';
    const price = priceId && (await findSellablePrice(priceId));
    if (!price) throw new HttpError(400, 'Unknown plan');
    const tenantId = req.tenant.id;
    if (await liveSubscription(tenantId)) {
      throw new HttpError(409, 'This workspace already has an active subscription — cancel it first');
    }
    const trialDays = price.trialDays > 0 && !(await trialUsed(tenantId)) ? price.trialDays : 0;
    await clearStale(tenantId);
    const summary = { method, name: price.planName, amount: price.amount, currency: price.currency, period: price.period, trialDays };

    if (method === 'auto') {
      const planId = await razorpayPlanFor(price).catch(razorpayError('Could not create the Razorpay plan'));
      const sub = await razorpay.subscriptions
        .create({
          plan_id: planId,
          total_count: TOTAL_COUNT[price.period],
          customer_notify: 1, // Razorpay emails/SMSes the customer about charges
          // With a trial, the mandate is set up now and the first charge happens when the trial ends.
          ...(trialDays && { start_at: Math.floor(Date.now() / 1000) + trialDays * 86400 }),
          notes: { tenantId: String(tenantId), priceId: String(price.id), planKey: price.planKey },
        })
        .catch(razorpayError('Could not create subscription'));
      await query(
        `INSERT INTO subscriptions (tenant_id, plan_id, price_id, collection_method, razorpay_subscription_id, trial_end, current_period_end)
         VALUES ($1, $2, $3, 'auto', $4, $5, $5)`,
        [tenantId, price.planId, price.id, sub.id, trialDays ? new Date(Date.now() + trialDays * 86400_000) : null]
      );
      return res.json({ ...summary, subscriptionId: sub.id });
    }

    if (trialDays) {
      // No payment details needed. The billing job opens the first invoice before the trial ends.
      await query(
        `INSERT INTO subscriptions (tenant_id, plan_id, price_id, collection_method, status, trial_end, current_period_start, current_period_end)
         VALUES ($1, $2, $3, 'manual', 'trialing', now() + make_interval(days => $4), now(), now() + make_interval(days => $4))`,
        [tenantId, price.planId, price.id, trialDays]
      );
      runBillingJob().catch((err) => console.error('[billing] job failed:', err)); // a short trial is due soon
      return res.json(summary);
    }

    const { rows } = await query(
      `INSERT INTO subscriptions (tenant_id, plan_id, price_id, collection_method) VALUES ($1, $2, $3, 'manual') RETURNING id`,
      [tenantId, price.planId, price.id]
    );
    const invoice = await openFirstInvoice(rows[0].id).catch(razorpayError('Could not create the order'));
    res.json({ ...summary, invoiceId: invoice.id, orderId: invoice.razorpay_order_id });
  });

  // Autopay: after Checkout authorises the mandate.
  router.post('/subscriptions/verify', requireUser, async (req, res) => {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body ?? {};
    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      throw new HttpError(400, 'Missing fields');
    }
    // Note the order: payment_id|subscription_id (orders sign order_id|payment_id).
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
    const { status } = await getSubscription(rows[0].id);
    if (!ACCESS.includes(status)) throw new HttpError(400, `Subscription is ${sub.status}`);
    res.json({ verified: true, status });
  });

  // Manual: after Checkout pays the first invoice's order.
  router.post('/invoices/:id/verify', requireUser, async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body ?? {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) throw new HttpError(400, 'Missing fields');
    if (!signedByRazorpay(`${razorpay_order_id}|${razorpay_payment_id}`, razorpay_signature)) {
      throw new HttpError(400, 'Invalid signature');
    }
    const { rows } = await query('SELECT * FROM invoices WHERE id = $1 AND tenant_id = $2 AND razorpay_order_id = $3', [
      toId(req.params.id),
      req.tenant.id,
      razorpay_order_id,
    ]);
    const invoice = rows[0];
    if (!invoice) throw new HttpError(404, 'Invoice not found');

    // Straight from Razorpay: right order, right amount, money actually taken.
    const payment = await razorpay.payments.fetch(razorpay_payment_id).catch(razorpayError('Could not fetch payment'));
    if (
      payment.order_id !== razorpay_order_id ||
      payment.amount !== invoice.amount ||
      !['authorized', 'captured'].includes(payment.status)
    ) {
      throw new HttpError(400, 'Payment mismatch');
    }
    await applyInvoicePayment(invoice.id, { paymentId: payment.id, amount: payment.amount });
    const { status } = await getSubscription(invoice.subscription_id);
    res.json({ verified: true, status });
  });

  router.post('/subscription/cancel', requireUser, requireRole('owner', 'admin'), async (req, res) => {
    const live = await liveSubscription(req.tenant.id);
    if (!live) throw new HttpError(404, 'No active subscription to cancel');
    // true: stop renewing but keep access until the paid period (or trial) ends. false: end it now.
    const atCycleEnd = Boolean(req.body?.atCycleEnd);

    if (live.collection_method === 'manual') {
      // Nothing to cancel at Razorpay; just stop billing. The job ends it when the period runs out.
      await voidOpenInvoices(live.id);
      await query(
        atCycleEnd
          ? `UPDATE subscriptions SET cancel_at_period_end = true, updated_at = now() WHERE id = $1`
          : `UPDATE subscriptions SET status = 'cancelled', ended_at = now(), updated_at = now() WHERE id = $1`,
        [live.id]
      );
    } else {
      const sub = await razorpay.subscriptions
        .cancel(live.razorpay_subscription_id, atCycleEnd)
        .catch(razorpayError('Could not cancel subscription'));
      // Razorpay keeps the status 'active' until the cycle ends and has no field for
      // "cancel scheduled", so remember it ourselves.
      if (atCycleEnd) await query('UPDATE subscriptions SET cancel_at_period_end = true WHERE id = $1', [live.id]);
      await applyRazorpaySubscription(sub);
    }
    res.json({ subscription: await subscriptionView(await getSubscription(live.id)) });
  });

  return router;
}
