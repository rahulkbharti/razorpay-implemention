import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { keyId } from './razorpay.js';
import { migrate } from './db.js';
import { initCatalog, listPublicPlans } from './catalog.js';
import { adminRouter } from './admin.js';
import { authRouter, loadSession } from './auth.js';
import { billingRouter, syncRazorpaySubscription } from './billing.js';
import { payInvoiceByLink, payInvoiceByOrder, runBillingJob } from './manual.js';
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

// Manual subscriptions are moved along (renewal invoices, reminders, grace period, expiry) by
// this job. It's safe to run any time; the Admin tab can also run it on demand.
const BILLING_JOB_EVERY = 60 * 60 * 1000;

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

  // Handlers are idempotent: Razorpay may send an event more than once.
  switch (event.event) {
    // A manual subscription's first invoice, paid in Checkout.
    case 'payment.captured':
    case 'order.paid':
      if (payment?.order_id) await payInvoiceByOrder(payment.order_id, payment);
      break;
    // A renewal invoice, paid from its payment link.
    case 'payment_link.paid':
      await payInvoiceByLink(event.payload.payment_link.entity.id, payment);
      break;
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
  res.json({ keyId, plans: await listPublicPlans() });
});

app.use('/api/auth', authRouter());
app.use('/api/admin', adminRouter(ADMIN_TOKEN));
app.use('/api', billingRouter());

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

async function billingJob() {
  try {
    const summary = await runBillingJob();
    if (Object.values(summary).some((n) => n)) console.log('[billing]', summary);
  } catch (err) {
    console.error('[billing] job failed:', err);
  }
}
billingJob();
setInterval(billingJob, BILLING_JOB_EVERY);
