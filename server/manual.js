// Manual collection: the customer pays each billing period themselves, without a mandate.
// The first period is paid in Checkout (a Razorpay order). Before each renewal the billing job
// opens an invoice with a Razorpay payment link and sends reminders to it. An unpaid renewal
// keeps its features during a grace period, then the subscription expires.
import { query, tx, withLock } from './db.js';
import { razorpay } from './razorpay.js';

const { CLIENT_ORIGIN = 'http://localhost:5173' } = process.env;

export const GRACE_DAYS = 7;
const INVOICE_AHEAD_DAYS = 7; // open the renewal invoice this long before it's due
const LINK_VALID_DAYS = 30; // a late payment is still accepted this long after the due date
// [days before due, kind], least urgent first. Each invoice gets each reminder at most once.
const REMINDERS = [
  [7, 'due_in_7'],
  [3, 'due_in_3'],
  [1, 'due_in_1'],
  [0, 'due_today'],
];
const LIVE = `('trialing', 'active', 'past_due')`;

const day = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

// The workspace owner, who gets the payment links and reminders.
const OWNER = `
  JOIN LATERAL (
    SELECT u.name, u.email, u.phone FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.tenant_id = s.tenant_id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1
  ) o ON true`;

/* ---------- Paying ---------- */

/** Opens the invoice for a manual subscription's first period, with the Razorpay order Checkout pays it with. */
export async function openFirstInvoice(subscriptionId) {
  const { rows } = await query(
    `INSERT INTO invoices (subscription_id, tenant_id, amount, currency, period_start, period_end, due_at)
     SELECT s.id, s.tenant_id, pp.amount, pp.currency, now(), now() + billing_interval(pp.period), now()
     FROM subscriptions s JOIN plan_prices pp ON pp.id = s.price_id
     WHERE s.id = $1
     RETURNING *`,
    [subscriptionId]
  );
  const invoice = rows[0];
  const order = await razorpay.orders.create({
    amount: invoice.amount,
    currency: invoice.currency,
    receipt: `inv_${invoice.id}`,
    notes: { invoiceId: String(invoice.id), tenantId: String(invoice.tenant_id) },
  });
  await query('UPDATE invoices SET razorpay_order_id = $2 WHERE id = $1', [invoice.id, order.id]);
  return { ...invoice, razorpay_order_id: order.id };
}

/**
 * Records a payment for an invoice and extends its subscription. Safe to call more than once:
 * webhooks repeat, and a page load re-checks open payment links. The paid period starts
 *   - where the current period (or trial) ends, when paying early, on time or within the grace period
 *   - today, for the first payment or after the subscription has ended
 */
export async function applyInvoicePayment(invoiceId, { paymentId = null, amount } = {}) {
  await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT i.*, pp.period FROM invoices i
       JOIN subscriptions s ON s.id = i.subscription_id JOIN plan_prices pp ON pp.id = s.price_id
       WHERE i.id = $1 FOR UPDATE OF i`,
      [invoiceId]
    );
    const invoice = rows[0];
    if (!invoice || invoice.status === 'paid') return;
    if (amount !== undefined && amount !== invoice.amount) {
      console.error(`[billing] payment ${paymentId} of ${amount} doesn't match invoice ${invoice.id} (${invoice.amount})`);
      return;
    }

    const { rows: subs } = await c.query('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE', [invoice.subscription_id]);
    const sub = subs[0];
    const continuing = ['trialing', 'active', 'past_due'].includes(sub.status);
    // Recorded as paid even if it can't be applied below, so the money is never lost track of.
    // A void invoice counts too: if the customer paid it anyway, they get what they paid for.
    const { rows: periods } = await c.query(
      `UPDATE invoices
       SET status = 'paid', paid_at = now(), razorpay_payment_id = $2,
           period_start = CASE WHEN $3 THEN $4::timestamptz ELSE now() END,
           period_end = CASE WHEN $3 THEN $4::timestamptz ELSE now() END + billing_interval($5)
       WHERE id = $1
       RETURNING period_start, period_end`,
      [invoice.id, paymentId, continuing, sub.current_period_end, invoice.period]
    );

    if (!continuing) {
      const { rows: other } = await c.query(
        `SELECT id FROM subscriptions WHERE tenant_id = $1 AND id <> $2 AND status IN ${LIVE}`,
        [sub.tenant_id, sub.id]
      );
      if (other[0]) {
        console.error(`[billing] invoice ${invoice.id} was paid, but workspace ${sub.tenant_id} already has subscription ${other[0].id} — refund it by hand`);
        return;
      }
    }
    await c.query(
      `UPDATE subscriptions
       SET status = 'active', current_period_start = $2, current_period_end = $3, ended_at = NULL,
           cancel_at_period_end = false, updated_at = now()
       WHERE id = $1`,
      [sub.id, periods[0].period_start, periods[0].period_end]
    );
  });
}

/** For order.paid / payment.captured webhooks. */
export async function payInvoiceByOrder(orderId, payment) {
  const { rows } = await query('SELECT id FROM invoices WHERE razorpay_order_id = $1', [orderId]);
  if (rows[0]) await applyInvoicePayment(rows[0].id, { paymentId: payment.id, amount: payment.amount });
}

/** For payment_link.paid webhooks. */
export async function payInvoiceByLink(linkId, payment) {
  const { rows } = await query('SELECT id FROM invoices WHERE razorpay_payment_link_id = $1', [linkId]);
  if (rows[0]) await applyInvoicePayment(rows[0].id, { paymentId: payment?.id ?? null, amount: payment?.amount });
}

// Asks Razorpay about a subscription's open payment links, so a payment shows up even when the
// webhook is late or not set up (e.g. locally). The link's callback brings the customer back here.
export async function syncOpenLinks(subscriptionId) {
  const { rows } = await query(
    `SELECT id, razorpay_payment_link_id FROM invoices
     WHERE subscription_id = $1 AND status = 'open' AND razorpay_payment_link_id IS NOT NULL`,
    [subscriptionId]
  );
  for (const invoice of rows) {
    const link = await razorpay.paymentLink.fetch(invoice.razorpay_payment_link_id);
    if (link.status === 'paid') {
      await applyInvoicePayment(invoice.id, { paymentId: link.payments?.[0]?.payment_id ?? null, amount: link.amount_paid });
    }
  }
}

/** Voids a subscription's unpaid invoices (e.g. it was cancelled) and cancels their payment links. */
export async function voidOpenInvoices(subscriptionId) {
  const { rows } = await query(
    `UPDATE invoices SET status = 'void' WHERE subscription_id = $1 AND status = 'open' RETURNING razorpay_payment_link_id`,
    [subscriptionId]
  );
  await cancelLinks(rows);
}

/** The same for every subscription of a workspace, e.g. before it starts a new one. */
export async function voidTenantInvoices(tenantId) {
  const { rows } = await query(
    `UPDATE invoices SET status = 'void' WHERE tenant_id = $1 AND status = 'open' RETURNING razorpay_payment_link_id`,
    [tenantId]
  );
  await cancelLinks(rows);
}

async function cancelLinks(rows) {
  for (const { razorpay_payment_link_id: id } of rows) {
    if (id) await razorpay.paymentLink.cancel(id).catch((err) => console.warn(`[billing] could not cancel ${id}:`, err?.error?.description ?? err.message));
  }
}

/* ---------- Billing job ---------- */

// The renewal invoice gets a payment link Razorpay hosts, so the customer can pay from the
// reminder without logging in. Razorpay doesn't notify on creation; the reminders do.
async function attachPaymentLink(invoice) {
  const { rows } = await query(
    `SELECT o.*, p.name AS plan_name, pp.period
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN plan_prices pp ON pp.id = s.price_id ${OWNER}
     WHERE s.id = $1`,
    [invoice.subscription_id]
  );
  const o = rows[0];
  const link = await razorpay.paymentLink.create({
    amount: invoice.amount,
    currency: invoice.currency,
    accept_partial: false,
    description: `${o.plan_name} (${o.period}) from ${day(invoice.period_start)}`,
    reference_id: `inv_${invoice.id}`,
    customer: { name: o.name, email: o.email, ...(o.phone && { contact: o.phone }) },
    notify: { sms: false, email: false },
    reminder_enable: false,
    expire_by: Math.floor(new Date(invoice.due_at).getTime() / 1000) + LINK_VALID_DAYS * 86400,
    callback_url: CLIENT_ORIGIN,
    callback_method: 'get',
    notes: { invoiceId: String(invoice.id), tenantId: String(invoice.tenant_id) },
  });
  await query('UPDATE invoices SET razorpay_payment_link_id = $2, payment_link_url = $3 WHERE id = $1', [
    invoice.id,
    link.id,
    link.short_url,
  ]);
}

// Razorpay sends the payment link by email, and by SMS when we have a phone number.
async function sendReminder(invoice, kind) {
  for (const medium of invoice.phone ? ['email', 'sms'] : ['email']) {
    await razorpay.paymentLink
      .notifyBy(invoice.razorpay_payment_link_id, medium)
      .catch((err) => console.warn(`[billing] ${medium} reminder for invoice ${invoice.id} failed:`, err?.error?.description ?? err.message));
  }
  console.log(`[billing] ${kind} reminder for invoice ${invoice.id} sent to ${invoice.email}`);
}

/**
 * Moves manual subscriptions along: ends what's over, opens renewal invoices, sends reminders and
 * voids invoices too old to pay. Runs every hour and is safe to run any time, as often as you like.
 */
export async function runBillingJob() {
  const summary = await withLock('billing-job', async () => {
    const count = async (sql, params = []) => (await query(sql, params)).rowCount;
    const manual = `collection_method = 'manual'`;
    const s = {};

    // 1. End what's over. The order matters: a scheduled cancellation wins over everything else.
    s.cancelled = await count(
      `UPDATE subscriptions
       SET status = 'cancelled', ended_at = current_period_end, cancel_at_period_end = false, updated_at = now()
       WHERE ${manual} AND cancel_at_period_end AND status IN ${LIVE} AND current_period_end <= now()`
    );
    // There's no grace period after a trial: it was never paid for.
    s.trialsEnded = await count(
      `UPDATE subscriptions SET status = 'expired', ended_at = current_period_end, updated_at = now()
       WHERE ${manual} AND status = 'trialing' AND current_period_end <= now()`
    );
    s.pastDue = await count(
      `UPDATE subscriptions SET status = 'past_due', updated_at = now()
       WHERE ${manual} AND status = 'active' AND current_period_end <= now()`
    );
    s.expired = await count(
      `UPDATE subscriptions SET status = 'expired', ended_at = current_period_end + make_interval(days => $1), updated_at = now()
       WHERE ${manual} AND status = 'past_due' AND current_period_end + make_interval(days => $1) <= now()`,
      [GRACE_DAYS]
    );

    // 2. Open the invoice for the next period once it's close. Renewals keep the price the
    //    customer signed up at, even if that price has since been retired.
    s.invoicesOpened = await count(
      `INSERT INTO invoices (subscription_id, tenant_id, amount, currency, period_start, period_end, due_at)
       SELECT s.id, s.tenant_id, pp.amount, pp.currency,
              s.current_period_end, s.current_period_end + billing_interval(pp.period), s.current_period_end
       FROM subscriptions s JOIN plan_prices pp ON pp.id = s.price_id
       WHERE s.${manual} AND s.status IN ${LIVE} AND NOT s.cancel_at_period_end
         AND s.current_period_end <= now() + make_interval(days => $1)
       ON CONFLICT (subscription_id, period_start) DO NOTHING`,
      [INVOICE_AHEAD_DAYS]
    );

    // 3. Payment links for renewal invoices that don't have one yet (this also retries failures).
    const { rows: needLinks } = await query(
      `SELECT i.* FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id
       WHERE i.status = 'open' AND i.razorpay_payment_link_id IS NULL AND i.razorpay_order_id IS NULL
         AND s.status IN ${LIVE}`
    );
    s.links = 0;
    for (const invoice of needLinks) {
      await attachPaymentLink(invoice).then(
        () => s.links++,
        (err) => console.error(`[billing] payment link for invoice ${invoice.id} failed:`, err?.error?.description ?? err.message)
      );
    }

    // 4. Reminders: the most urgent one that's due and not sent yet. One created late skips the
    //    earlier ones instead of sending them all at once.
    const { rows: open } = await query(
      `SELECT i.id, i.razorpay_payment_link_id, o.email, o.phone,
              extract(epoch FROM i.due_at - now()) / 86400 AS days_left
       FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id ${OWNER}
       WHERE i.status = 'open' AND i.razorpay_payment_link_id IS NOT NULL AND s.status IN ${LIVE}`
    );
    s.reminders = 0;
    for (const invoice of open) {
      const kind = REMINDERS.filter(([days]) => Number(invoice.days_left) <= days).at(-1)?.[1];
      if (!kind) continue;
      const { rowCount } = await query(
        'INSERT INTO invoice_reminders (invoice_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [invoice.id, kind]
      );
      if (rowCount) {
        await sendReminder(invoice, kind);
        s.reminders++;
      }
    }

    // 5. Too late to pay this one: the customer can subscribe again from the pricing page.
    const { rows: voided } = await query(
      `UPDATE invoices SET status = 'void'
       WHERE status = 'open' AND due_at + make_interval(days => $1) <= now()
       RETURNING razorpay_payment_link_id`,
      [LINK_VALID_DAYS]
    );
    await cancelLinks(voided);
    s.voided = voided.length;
    return s;
  });
  return summary ?? { skipped: 'another run is in progress' };
}
