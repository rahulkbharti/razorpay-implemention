import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatLimit, rupees } from './api.js';
import { openCheckout } from './useRazorpay.js';
import { styles } from './styles.js';

const PER = { monthly: 'month', yearly: 'year' };
const LIVE = ['active', 'past_due']; // still billing, so no second subscription
const INVOICE_STATUS = { paid: 'Paid', issued: 'Due', expired: 'Expired', cancelled: 'Cancelled' };
const STATUS_LABEL = { past_due: 'past due' };

const date = (value) =>
  value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export default function Subscriptions({ config, me, onChange }) {
  const [period, setPeriod] = useState('monthly');
  const [sub, setSub] = useState(null);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const polls = useRef(0);
  const canBill = me.tenant.role !== 'member';

  // The server re-reads it from Razorpay, so the plan in `me` may have changed too.
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

  // Right after Checkout the first charge may still be settling, so there's no period yet.
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
      const s = await api('/api/subscriptions', { priceId });
      const response = await openCheckout(
        {
          key: config.keyId,
          subscription_id: s.subscriptionId, // no amount/order_id — Razorpay takes them from the plan
          name: 'My SaaS',
          description: `${s.name} — ${rupees(s.amount)} / ${PER[s.period]}`,
          prefill: { name: me.user.name, email: me.user.email, contact: me.user.phone ?? undefined },
          theme: { color: '#3b5bdb' },
        },
        (msg) => setResult({ ok: false, msg })
      );
      if (!response) return; // closed without paying

      await api('/api/subscriptions/verify', response);
      polls.current = 0;
      await refresh();
      setResult({ ok: true, msg: `Subscribed to ${s.name}` });
    } catch (e) {
      setResult({ ok: false, msg: e.message });
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    // Active: stop renewing but keep what they paid for. Past due: end it now.
    const atCycleEnd = sub.status === 'active';
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
        <div style={styles.toggle}>
          {Object.keys(PER).map((p) => (
            <button key={p} style={styles.toggleBtn(period === p)} onClick={() => setPeriod(p)}>
              {p === 'monthly' ? 'Monthly' : 'Yearly'}
            </button>
          ))}
        </div>
      </div>

      <div style={styles.grid}>
        {plans.map((p) => {
          const current = p.key === currentKey;
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
                {current ? 'Current plan' : !p.price ? 'Free forever' : busy === p.price.id ? 'Processing…' : 'Subscribe'}
              </button>
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
  // One invoice per billing cycle. An unpaid one only matters while the subscription is still billing.
  const payments = sub.payments.filter((p) => p.status === 'paid' || (live && p.status === 'issued'));
  return (
    <section style={styles.panel}>
      <div style={styles.panelHead}>
        <div>
          <strong>
            {sub.name} · {rupees(sub.amount)} / {PER[sub.period]}
          </strong>
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
  switch (sub.status) {
    case 'active':
      if (!sub.currentPeriodEnd) return 'Payment method authorised — the first charge is being processed…';
      return sub.cancelAtPeriodEnd
        ? `Cancelled — no more charges. ${sub.name} stays on until ${date(sub.currentPeriodEnd)}.`
        : `Autopay renews it on ${date(sub.currentPeriodEnd)} for ${rupees(sub.amount)}.`;
    case 'past_due':
      return 'The last renewal failed. Razorpay is retrying the charge automatically; your features stay on meanwhile.';
    case 'halted':
      return 'Every renewal retry failed, so the workspace is back on the free plan. Subscribe again to continue.';
    case 'cancelled':
      return `Cancelled on ${date(sub.endedAt)}.`;
    case 'expired':
      return `Ended on ${date(sub.endedAt)}.`;
    default:
      return `Status: ${sub.status}`;
  }
}
