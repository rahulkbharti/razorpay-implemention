import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatLimit, rupees } from './api.js';
import { openCheckout } from './useRazorpay.js';
import { styles } from './styles.js';

const PER = { monthly: 'month', yearly: 'year' };
const METHODS = { auto: 'Autopay', manual: 'Pay each time' };
const METHOD_HELP = {
  auto: 'Charged automatically each period with UPI Autopay or a card mandate. Cancel any time.',
  manual: 'No mandate. Before each renewal we send a payment link by email and SMS; pay it by UPI, card or netbanking.',
};
const LIVE = ['trialing', 'active', 'past_due']; // still billing, so no second subscription
const INVOICE_STATUS = { paid: 'Paid', issued: 'Due', expired: 'Expired', cancelled: 'Cancelled' };
const STATUS_LABEL = { past_due: 'past due', trialing: 'trial' };

const date = (value) =>
  value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export default function Subscriptions({ config, me, onChange }) {
  const [period, setPeriod] = useState('monthly');
  const [method, setMethod] = useState('auto');
  const [sub, setSub] = useState(null);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const polls = useRef(0);
  const canBill = me.tenant.role !== 'member';

  // The server re-checks Razorpay (subscription status, payment links), so the plan in `me` may have changed too.
  const refresh = useCallback(async () => {
    try {
      setSub((await api('/api/subscription')).subscription);
      await onChange();
    } catch (e) {
      setResult({ ok: false, msg: e.message });
    }
  }, [onChange]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Right after an autopay Checkout the first charge may still be settling, so there's no period yet.
  useEffect(() => {
    if (sub?.status !== 'active' || sub.currentPeriodEnd || polls.current >= 10) return;
    const t = setTimeout(() => {
      polls.current += 1;
      refresh();
    }, 3000);
    return () => clearTimeout(t);
  }, [sub, refresh]);

  async function subscribe(priceId) {
    setBusy(priceId);
    setResult(null);
    try {
      const s = await api('/api/subscriptions', { priceId, method });
      const checkout = {
        key: config.keyId,
        name: 'My SaaS',
        description: `${s.name} — ${rupees(s.amount)} / ${PER[s.period]}`,
        prefill: { name: me.user.name, email: me.user.email, contact: me.user.phone ?? undefined },
        theme: { color: '#3b5bdb' },
      };
      const onFailedAttempt = (msg) => setResult({ ok: false, msg });

      if (s.method === 'auto') {
        // No amount or order: Razorpay takes them from the plan. With a trial this only sets up the mandate.
        if (s.trialDays) checkout.description = `${s.trialDays}-day free trial, then ${checkout.description}`;
        const response = await openCheckout({ ...checkout, subscription_id: s.subscriptionId }, onFailedAttempt);
        if (!response) return; // closed without finishing
        await api('/api/subscriptions/verify', response);
      } else if (s.orderId) {
        // Manual: pay the first period now.
        const response = await openCheckout(
          { ...checkout, order_id: s.orderId, amount: s.amount, currency: s.currency },
          onFailedAttempt
        );
        if (!response) return;
        await api(`/api/invoices/${s.invoiceId}/verify`, response);
      }
      // Otherwise it's a manual trial, which starts without paying anything.

      polls.current = 0;
      await refresh();
      setResult({ ok: true, msg: s.trialDays ? `Your ${s.trialDays}-day ${s.name} trial has started` : `Subscribed to ${s.name}` });
    } catch (e) {
      setResult({ ok: false, msg: e.message });
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    // Keep what's paid for (or the rest of a manual trial). An autopay trial or a past-due
    // subscription ends now.
    const atCycleEnd = sub.status === 'active' || (sub.collectionMethod === 'manual' && sub.status === 'trialing');
    const question = atCycleEnd
      ? `Cancel your subscription? You keep ${sub.name} until ${date(sub.currentPeriodEnd)}.`
      : 'Cancel your subscription? The workspace goes back to the free plan now.';
    if (!window.confirm(question)) return;

    setBusy('cancel');
    setResult(null);
    try {
      setSub((await api('/api/subscription/cancel', { atCycleEnd })).subscription);
      await onChange();
    } catch (e) {
      setResult({ ok: false, msg: e.message });
    } finally {
      setBusy(null);
    }
  }

  const live = sub && LIVE.includes(sub.status);
  const currentKey = me.plan?.key;
  // A plan with no prices is free and shows under both periods.
  const plans = config.plans
    .map((p) => ({ ...p, price: p.prices.find((pr) => pr.period === period) }))
    .filter((p) => p.price || p.prices.length === 0);

  return (
    <>
      {sub && <CurrentSubscription sub={sub} busy={!!busy} canBill={canBill} onCancel={cancel} />}

      <div style={styles.header}>
        <h1 style={{ margin: 0 }}>Choose a plan</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Toggle options={{ monthly: 'Monthly', yearly: 'Yearly' }} value={period} onChange={setPeriod} />
          <Toggle options={METHODS} value={method} onChange={setMethod} />
        </div>
      </div>
      <p style={{ ...styles.muted, margin: '-4px 0 16px' }}>{METHOD_HELP[method]}</p>

      <div style={styles.grid}>
        {plans.map((p) => {
          const current = p.key === currentKey;
          const trial = p.price && p.trialDays > 0 && me.trialAvailable ? p.trialDays : 0;
          const disabled = !!busy || live || !p.price || current || !canBill;
          return (
            <div key={p.key} style={styles.card}>
              <h2 style={{ margin: 0 }}>{p.name}</h2>
              {p.description && <p style={styles.muted}>{p.description}</p>}
              <p style={styles.price}>
                {p.price ? rupees(p.price.amount) : '₹0'}
                <span style={styles.per}> / {PER[period]}</span>
              </p>
              <button style={styles.btn(disabled)} disabled={disabled} onClick={() => subscribe(p.price.id)}>
                {current
                  ? 'Current plan'
                  : !p.price
                    ? 'Free forever'
                    : busy === p.price.id
                      ? 'Processing…'
                      : trial
                        ? `Start ${trial}-day free trial`
                        : 'Subscribe'}
              </button>
              {trial > 0 && !current && (
                <p style={{ ...styles.muted, fontSize: 13 }}>
                  {method === 'auto'
                    ? `Set up autopay now; the first charge is after ${trial} days.`
                    : `Nothing to pay now. We'll send a payment link before the trial ends.`}
                </p>
              )}
              <ul style={styles.featureList}>
                {p.features.map((f) => (
                  <Feature key={f.key} feature={f} />
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {!canBill && <p style={styles.muted}>Only the workspace owner or an admin can change the plan.</p>}
      {result && <p style={styles.notice(result.ok)}>{result.msg}</p>}
    </>
  );
}

function Toggle({ options, value, onChange }) {
  return (
    <div style={styles.toggle}>
      {Object.entries(options).map(([id, label]) => (
        <button key={id} style={styles.toggleBtn(value === id)} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Feature({ feature: f }) {
  const on = f.type === 'boolean' ? f.value : f.value !== 0;
  return (
    <li style={styles.feature(on)}>
      {on ? '✓' : '✕'} {f.type === 'limit' ? `${f.name}: ${formatLimit(f.value)}` : f.name}
    </li>
  );
}

function CurrentSubscription({ sub, busy, canBill, onCancel }) {
  const live = LIVE.includes(sub.status);
  // An unpaid invoice only matters while the subscription is still billing.
  const payments = sub.payments.filter((p) => p.status === 'paid' || (live && p.status === 'issued'));
  return (
    <section style={styles.panel}>
      <div style={styles.panelHead}>
        <div>
          <strong>
            {sub.name} · {rupees(sub.amount)} / {PER[sub.period]}
          </strong>
          <span style={styles.per}> · {METHODS[sub.collectionMethod]}</span>
          <span style={styles.badge(sub.cancelAtPeriodEnd ? 'cancelling' : sub.status)}>
            {sub.cancelAtPeriodEnd ? 'cancelling' : (STATUS_LABEL[sub.status] ?? sub.status)}
          </span>
        </div>
        {live && !sub.cancelAtPeriodEnd && canBill && (
          <button style={styles.linkBtn} disabled={busy} onClick={onCancel}>
            Cancel subscription
          </button>
        )}
      </div>

      <p style={styles.muted}>{describe(sub)}</p>

      {/* Opens Razorpay's payment page; its callback brings the customer back here, where the payment shows up. */}
      {sub.openInvoice && canBill && (
        <a href={sub.openInvoice.payUrl} style={{ ...styles.payBtn, marginTop: 12 }}>
          Pay {rupees(sub.openInvoice.amount)} now
        </a>
      )}

      {payments.length > 0 && (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Date</th>
                <th style={styles.th}>Amount</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Payment</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.invoiceId}>
                  <td style={styles.td}>{date(p.date)}</td>
                  <td style={styles.td}>{rupees(p.amount)}</td>
                  <td style={styles.td}>{INVOICE_STATUS[p.status] ?? p.status}</td>
                  <td style={styles.td}>{p.paymentId ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function describe(sub) {
  const manual = sub.collectionMethod === 'manual';
  const until = date(sub.currentPeriodEnd);
  switch (sub.status) {
    case 'trialing':
      if (sub.cancelAtPeriodEnd) return `Trial cancelled — ${sub.name} stays on until ${until}.`;
      return manual
        ? `Free trial until ${until}. Pay ${rupees(sub.amount)} by then to keep ${sub.name}.`
        : `Free trial until ${until}. Autopay then charges ${rupees(sub.amount)} / ${PER[sub.period]}.`;
    case 'active':
      if (!sub.currentPeriodEnd) return 'Payment method authorised — the first charge is being processed…';
      if (sub.cancelAtPeriodEnd) return `Cancelled — no more charges. ${sub.name} stays on until ${until}.`;
      if (!manual) return `Autopay renews it on ${until} for ${rupees(sub.amount)}.`;
      return sub.openInvoice
        ? `Paid until ${until}. Your next payment is ready.`
        : `Paid until ${until}. We'll send a payment link a week before.`;
    case 'past_due':
      return manual
        ? `Payment overdue since ${until}. Your features stay on until ${date(sub.graceEndsAt)}; pay to keep them.`
        : 'The last renewal failed. Razorpay is retrying the charge automatically; your features stay on meanwhile.';
    case 'halted':
      return 'Every renewal retry failed, so the workspace is back on the free plan. Subscribe again to continue.';
    case 'cancelled':
      return `Cancelled on ${date(sub.endedAt)}.`;
    case 'expired':
      return sub.openInvoice
        ? `Ended on ${date(sub.endedAt)}. Pay the pending invoice to start a new period from today.`
        : `Ended on ${date(sub.endedAt)}.`;
    default:
      return `Status: ${sub.status}`;
  }
}
