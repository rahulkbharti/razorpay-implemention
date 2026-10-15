// Changing a live subscription: to another plan or period, or how it's paid.
//
// Plan changes. What it costs per month decides when:
//   dearer, same period length  → now: pay the prorated difference for the rest of the period
//   cheaper, or monthly ↔ yearly → when the current period ends, so nothing paid for is lost
//   during a trial               → now, free
// Autopay: Razorpay is told to bill the new plan from the next cycle (schedule_change_at
// 'cycle_end'); the prorated difference is charged by us, with an order (see manual.js).
//
// Payment method. Autopay → manual: Razorpay stops charging after this cycle, and the billing job
// invoices the next period like any manual one. Manual → autopay: the customer sets up a mandate
// whose first charge is when the current period ends.
import express from 'express';
import { query } from './db.js';
import { findPrice, findSellablePrice, listFeatures, resolveEntitlements } from './catalog.js';
import { requireRole, requireUser } from './auth.js';
import { razorpay, signedByRazorpay } from './razorpay.js';
import { currentUsage } from './entitlements.js';
import {
  TOTAL_COUNT,
  applyRazorpaySubscription,
  currentPlan,
  getSubscription,
  liveSubscription,
  razorpayError,
  razorpayPlanFor,
  subscriptionView,
  tenantOverrides,
} from './billing.js';
import { openUpgradeInvoice, runBillingJob, voidOpenInvoices } from './manual.js';
import { HttpError, toId } from './util.js';

const MIN_CHARGE = 100; // Razorpay's minimum (₹1): a smaller prorated difference isn't charged
const METHOD = { auto: 'Autopay', manual: 'Pay each time' };

const perMonth = (p) => (p.period === 'yearly' ? p.amount / 12 : p.amount);
const isUpgrade = (live, price) => price.period === live.period && perMonth(price) > perMonth(live);

/** What switching the live subscription to `price` would do: { when: 'now' | 'period_end', amount }. */
function quote(live, price) {
  if (price.id === live.price_id) throw new HttpError(409, `You're already on ${price.planName} (${price.period})`);
  if (live.cancel_at_period_end) throw new HttpError(409, 'This subscription is set to cancel; subscribe again once it ends');
  if (live.status === 'past_due') throw new HttpError(409, 'Pay the overdue invoice first, then change plans');
  const auto = live.collection_method === 'auto';
  if (auto && price.period !== live.period) {
    throw new HttpError(409, "Autopay can't switch between monthly and yearly. Switch to Pay each time first, or cancel and subscribe again.");
  }
  // One change at a time. The exception: retrying an autopay upgrade whose charge wasn't paid
  // (starting it also schedules the switch, see below).
  if (live.pending_price_id && !(auto && live.pending_price_id === price.id && isUpgrade(live, price))) {
    throw new HttpError(409, 'A plan change is already scheduled — cancel it first');
  }
  if (live.status === 'trialing') return { when: 'now', amount: 0 };
  if (!live.current_period_start || !live.current_period_end) {
    throw new HttpError(409, 'Your first payment is still being processed — try again in a minute');
  }
  if (!isUpgrade(live, price)) return { when: 'period_end', amount: 0, at: live.current_period_end };

  const start = new Date(live.current_period_start).getTime();
  const end = new Date(live.current_period_end).getTime();
  const left = Math.min(1, Math.max(0, (end - Date.now()) / (end - start)));
  const amount = Math.round((price.amount - live.amount) * left);
  return { when: 'now', amount: amount < MIN_CHARGE ? 0 : amount };
}

// What the workspace would no longer have on the new plan: features turned off, and limits it's
// already over (it keeps everything, but can't add more; see entitlements.js).
async function losses(tenantId, planId) {
  const [features, overrides, usage, plan, { rows }] = await Promise.all([
    listFeatures(),
    tenantOverrides(tenantId),
    currentUsage(tenantId),
    currentPlan(tenantId),
    query('SELECT entitlements FROM plans WHERE id = $1', [planId]),
  ]);
  const now = new Map((plan?.features ?? []).map((f) => [f.key, f.value]));
  const next = resolveEntitlements(rows[0].entitlements, features, overrides);
  return {
    features: next.filter((f) => f.type === 'boolean' && !f.value && now.get(f.key) === true).map((f) => f.name),
    limits: next
      .filter((f) => f.type === 'limit' && f.value !== -1 && usage[f.key] > f.value)
      .map((f) => ({ name: f.name, limit: f.value, used: usage[f.key] })),
  };
}

const view = async (id) => subscriptionView(await getSubscription(id));

// A manual subscription's open renewal invoice billed the old price: void it (and its payment
// link), and let the billing job reissue it.
async function reissueRenewal(subscriptionId) {
  await voidOpenInvoices(subscriptionId);
  runBillingJob().catch((err) => console.error('[billing] job failed:', err));
}

/**
 * Makes Razorpay bill `price` from the next cycle ('now' during a trial: nothing has been charged).
 * If that's the plan Razorpay is already on (e.g. undoing a downgrade after an upgrade was paid),
 * it only drops whatever else was scheduled. Razorpay can refuse (not every mandate can change
 * amount); then nothing has changed.
 */
async function billFromNextCycle(s, price) {
  const id = s.razorpay_subscription_id;
  const planId = await razorpayPlanFor(price).catch(razorpayError('Could not create the Razorpay plan'));
  const rzp = await razorpay.subscriptions.fetch(id).catch(razorpayError('Could not fetch subscription'));
  const call =
    rzp.plan_id === planId
      ? rzp.has_scheduled_changes && razorpay.subscriptions.cancelScheduledChanges(id)
      : razorpay.subscriptions.update(id, {
          plan_id: planId,
          schedule_change_at: s.status === 'trialing' ? 'now' : 'cycle_end',
          customer_notify: 1,
        });
  await Promise.resolve(call).catch((err) => {
    console.error(err);
    throw new HttpError(
      502,
      `${err?.error?.description ?? 'Razorpay could not change the plan'}. To change plans anyway, switch to Pay each time first.`
    );
  });
}

const pendingSql = `UPDATE subscriptions
  SET pending_plan_id = $2, pending_price_id = $3, pending_change_at = current_period_end, updated_at = now()
  WHERE id = $1`;

export function changesRouter() {
  const router = express.Router();
  const billing = [requireUser, requireRole('owner', 'admin')];

  async function live(req) {
    const s = await liveSubscription(req.tenant.id);
    if (!s) throw new HttpError(404, 'No active subscription — choose a plan to subscribe');
    return s;
  }
  async function target(req) {
    const priceId = toId(req.body?.priceId);
    const price = priceId && (await findSellablePrice(priceId));
    if (!price) throw new HttpError(400, 'Unknown plan');
    return price;
  }

  // What a change would cost and do, for the confirmation step.
  router.post('/subscription/change/preview', ...billing, async (req, res) => {
    const [s, price] = await Promise.all([live(req), target(req)]);
    const q = quote(s, price);
    res.json({
      ...q,
      currency: price.currency,
      plan: { name: price.planName, period: price.period, amount: price.amount },
      losing: await losses(req.tenant.id, price.planId),
    });
  });

  router.post('/subscription/change', ...billing, async (req, res) => {
    const [s, price] = await Promise.all([live(req), target(req)]);
    const q = quote(s, price);
    const auto = s.collection_method === 'auto';
    const retry = auto && s.pending_price_id === price.id;

    // Autopay: Razorpay must bill the new plan from the next cycle. This goes first so that if
    // Razorpay refuses, nothing has changed or been charged yet.
    if (auto && !retry) await billFromNextCycle(s, price);

    if (q.when === 'period_end') {
      await query(pendingSql, [s.id, price.planId, price.id]);
      if (!auto) await reissueRenewal(s.id);
      return res.json({ scheduled: true, subscription: await view(s.id) });
    }

    if (q.amount === 0) {
      // A trial, or a difference too small to charge: switch now.
      await query(
        `UPDATE subscriptions SET plan_id = $2, price_id = $3, pending_plan_id = NULL, pending_price_id = NULL,
           pending_change_at = NULL, updated_at = now()
         WHERE id = $1`,
        [s.id, price.planId, price.id]
      );
      if (!auto) await reissueRenewal(s.id);
      return res.json({ changed: true, subscription: await view(s.id) });
    }

    // Dearer, now: the plan switches once the prorated difference is paid (applyUpgrade). For
    // autopay the switch is also scheduled for the cycle end, so that if the charge is never paid,
    // our record still follows what Razorpay bills from then on.
    if (auto && !retry) await query(pendingSql, [s.id, price.planId, price.id]);
    await query(`UPDATE invoices SET status = 'void' WHERE subscription_id = $1 AND kind = 'upgrade' AND status = 'open'`, [s.id]);
    const invoice = await openUpgradeInvoice(s, price, q.amount).catch(razorpayError('Could not create the order'));
    res.json({
      invoiceId: invoice.id,
      orderId: invoice.razorpay_order_id,
      amount: q.amount,
      currency: price.currency,
      name: price.planName,
      period: price.period,
    });
  });

  router.post('/subscription/change/cancel', ...billing, async (req, res) => {
    const s = await live(req);
    if (!s.pending_price_id) throw new HttpError(404, 'No plan change is scheduled');
    // Autopay: Razorpay goes back to billing the plan the workspace is on now. Not simply "cancel
    // scheduled changes": after a paid upgrade, Razorpay's own plan is still the old one until the
    // cycle ends, and the upgrade is itself a scheduled change.
    if (s.collection_method === 'auto') await billFromNextCycle(s, await findPrice(s.price_id));
    await query(
      `UPDATE subscriptions SET pending_plan_id = NULL, pending_price_id = NULL, pending_change_at = NULL, updated_at = now()
       WHERE id = $1`,
      [s.id]
    );
    // Manual: the renewal invoice billed the scheduled price. Autopay: an unpaid upgrade charge.
    if (s.collection_method === 'manual') await reissueRenewal(s.id);
    else await voidOpenInvoices(s.id);
    res.json({ subscription: await view(s.id) });
  });

  router.post('/subscription/method', ...billing, async (req, res) => {
    const method = req.body?.method;
    if (!METHOD[method]) throw new HttpError(400, 'method must be "auto" or "manual"');
    const s = await live(req);
    if (s.collection_method === method) throw new HttpError(409, `It's already paid by ${METHOD[method]}`);
    if (s.cancel_at_period_end) throw new HttpError(409, 'This subscription is set to cancel; subscribe again once it ends');
    if (s.status === 'past_due') throw new HttpError(409, 'Pay the overdue invoice first');
    if (!s.current_period_end) throw new HttpError(409, 'Your first payment is still being processed — try again in a minute');

    if (method === 'manual') {
      // Razorpay stops after this cycle. A mandate that hasn't charged anything yet (a trial) is
      // cancelled outright. Its later events are ignored: the row isn't on autopay any more.
      const rzp = await razorpay.subscriptions
        .fetch(s.razorpay_subscription_id)
        .catch(razorpayError('Could not fetch subscription'));
      await razorpay.subscriptions
        .cancel(s.razorpay_subscription_id, rzp.status !== 'authenticated')
        .catch(razorpayError('Could not stop autopay'));
      await query(`UPDATE subscriptions SET collection_method = 'manual', updated_at = now() WHERE id = $1`, [s.id]);
      runBillingJob().catch((err) => console.error('[billing] job failed:', err)); // the renewal may be due within a week
      return res.json({ subscription: await view(s.id) });
    }

    // Manual → autopay: a mandate for the next period's price (a scheduled change's, if any),
    // first charged when the current period ends. Stays manual until Checkout authorises it.
    const nextPriceId = s.pending_change_at && s.pending_change_at <= s.current_period_end ? s.pending_price_id : s.price_id;
    const price = await findPrice(nextPriceId);
    if (s.razorpay_subscription_id) {
      // An earlier switch that was never finished, or the autopay this subscription had before.
      await razorpay.subscriptions.cancel(s.razorpay_subscription_id, false).catch(() => {});
    }
    const planId = await razorpayPlanFor(price).catch(razorpayError('Could not create the Razorpay plan'));
    const sub = await razorpay.subscriptions
      .create({
        plan_id: planId,
        total_count: TOTAL_COUNT[price.period],
        customer_notify: 1,
        start_at: Math.floor(new Date(s.current_period_end).getTime() / 1000),
        notes: { tenantId: String(req.tenant.id), priceId: String(price.id), planKey: price.planKey },
      })
      .catch(razorpayError('Could not create subscription'));
    await query('UPDATE subscriptions SET razorpay_subscription_id = $2, updated_at = now() WHERE id = $1', [s.id, sub.id]);
    res.json({
      subscriptionId: sub.id,
      name: price.planName,
      amount: price.amount,
      period: price.period,
      startsAt: s.current_period_end,
    });
  });

  // After Checkout authorises the mandate for a switch to autopay.
  router.post('/subscription/method/verify', ...billing, async (req, res) => {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body ?? {};
    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) throw new HttpError(400, 'Missing fields');
    if (!signedByRazorpay(`${razorpay_payment_id}|${razorpay_subscription_id}`, razorpay_signature)) {
      throw new HttpError(400, 'Invalid signature');
    }
    const { rows } = await query(
      `SELECT id FROM subscriptions WHERE razorpay_subscription_id = $1 AND tenant_id = $2 AND collection_method = 'manual'
         AND status IN ('trialing', 'active')`,
      [razorpay_subscription_id, req.tenant.id]
    );
    if (!rows[0]) throw new HttpError(404, 'Subscription not found');
    const sub = await razorpay.subscriptions.fetch(razorpay_subscription_id).catch(razorpayError('Could not fetch subscription'));
    if (!['authenticated', 'active'].includes(sub.status)) throw new HttpError(400, `Mandate is ${sub.status}`);

    await query(`UPDATE subscriptions SET collection_method = 'auto', updated_at = now() WHERE id = $1`, [rows[0].id]);
    await voidOpenInvoices(rows[0].id); // the renewal's payment link isn't needed any more
    await applyRazorpaySubscription(sub);
    res.json({ verified: true, subscription: await view(rows[0].id) });
  });

  return router;
}
