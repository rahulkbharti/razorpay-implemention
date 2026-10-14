import { useCallback, useEffect, useRef, useState } from 'react';
import { api, rupees } from './api.js';
import { openCheckout } from './useRazorpay.js';
import { styles } from './styles.js';

const PER = { monthly: 'month', yearly: 'year' };
const LIVE = ['authenticated', 'active', 'pending']; // still billing, so no second subscription
const INVOICE_STATUS = { paid: 'Paid', issued: 'Due', expired: 'Expired', cancelled: 'Cancelled' };

const date = (unix) =>
  unix ? new Date(unix * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

// No login in this demo, so the browser remembers its own subscription id.
// In a real app the server finds the subscription from the logged-in user.
const STORAGE_KEY = 'subscriptionId';
function savedId() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function saveId(id) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage blocked — the subscription still works, it just won't show after a reload
  }
}

export default function Subscriptions({ config }) {
  const [period, setPeriod] = useState('monthly');
  const [sub, setSub] = useState(null);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const polls = useRef(0);

  const refresh = useCallback(async (id) => {
    if (!id) return;
    try {
      setSub(await api(`/api/subscriptions/${id}`));
    } catch (e) {
      if (e.status === 404 || e.status === 400) saveId(null); // stale id
      else setResult({ ok: false, msg: e.message });
    }
  }, []);

  useEffect(() => {
    refresh(savedId());
  }, [refresh]);

  // Right after Checkout the first charge may still be settling ('authenticated' → 'active').
  useEffect(() => {
    if (sub?.status !== 'authenticated' || polls.current >= 10) return;
    const t = setTimeout(() => {
      polls.current += 1;
      refresh(sub.id);
    }, 3000);
    return () => clearTimeout(t);
  }, [sub, refresh]);

  async function subscribe(planKey) {
    setBusy(planKey);
    setResult(null);
    try {
      const s = await api('/api/subscriptions', { planKey });
      const response = await openCheckout(
        {
          key: config.keyId,
          subscription_id: s.subscriptionId, // no amount/order_id — Razorpay takes them from the plan
          name: 'My SaaS',
          description: `${s.name} — ${rupees(s.amount)} / ${PER[s.period]}`,
          theme: { color: '#3b5bdb' },
        },
        (msg) => setResult({ ok: false, msg })
      );
      if (!response) return; // closed without paying

      const v = await api('/api/subscriptions/verify', response);
      saveId(v.subscriptionId);
      polls.current = 0;
      await refresh(v.subscriptionId);
      setResult({ ok: true, msg: `Subscribed — ${v.subscriptionId}` });
    } catch (e) {
      setResult({ ok: false, msg: e.message });
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    // Active: stop renewing but keep what they paid for. Anything else: end it now.
    const atCycleEnd = sub.status === 'active';
    const question = atCycleEnd
      ? `Cancel your subscription? You keep access until ${date(sub.currentEnd)}.`
      : 'Cancel your subscription?';
    if (!window.confirm(question)) return;

    setBusy('cancel');
    setResult(null);
    try {
      setSub(await api(`/api/subscriptions/${sub.id}/cancel`, { atCycleEnd }));
    } catch (e) {
      setResult({ ok: false, msg: e.message });
    } finally {
      setBusy(null);
    }
  }

  function dismiss() {
    saveId(null);
    setSub(null);
    setResult(null);
  }

  const live = sub && LIVE.includes(sub.status);
  const plans = Object.entries(config.plans).filter(([, p]) => p.period === period);

  return (
    <>
      {sub && <CurrentSubscription sub={sub} busy={!!busy} onCancel={cancel} onDismiss={dismiss} />}

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
        {plans.map(([key, p]) => {
          const disabled = !!busy || live;
          return (
            <div key={key} style={styles.card}>
              <h2 style={{ margin: 0 }}>{p.name}</h2>
              <p style={styles.price}>
                {rupees(p.amount)}
                <span style={styles.per}> / {PER[p.period]}</span>
              </p>
              <button style={styles.btn(disabled)} disabled={disabled} onClick={() => subscribe(key)}>
                {live && sub.planKey === key ? 'Current plan' : busy === key ? 'Processing…' : 'Subscribe'}
              </button>
            </div>
          );
        })}
      </div>

      {result && <p style={styles.notice(result.ok)}>{result.msg}</p>}
    </>
  );
}

function CurrentSubscription({ sub, busy, onCancel, onDismiss }) {
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
          <span style={styles.badge(sub.status)}>{sub.cancelScheduled ? 'cancelling' : sub.status}</span>
        </div>
        {live && !sub.cancelScheduled && (
          <button style={styles.linkBtn} disabled={busy} onClick={onCancel}>
            Cancel subscription
          </button>
        )}
        {!live && (
          <button style={{ ...styles.linkBtn, color: '#495057' }} onClick={onDismiss}>
            Dismiss
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
    case 'authenticated':
      return 'Payment method authorised — the first charge is being processed…';
    case 'active':
      return sub.cancelScheduled
        ? `Cancelled — no more charges. Access until ${date(sub.currentEnd)}.`
        : `Renews on ${date(sub.chargeAt)} for ${rupees(sub.amount)} · ${sub.paidCount} of ${sub.totalCount} payments made.`;
    case 'pending':
      return 'The last renewal failed. Razorpay is retrying the charge automatically.';
    case 'halted':
      return 'All renewal retries failed, so the subscription is halted. Subscribe again to continue.';
    case 'cancelled':
      return `Cancelled on ${date(sub.endedAt)}.`;
    case 'completed':
      return `Completed — all ${sub.totalCount} payments made.`;
    default:
      return `Status: ${sub.status}`;
  }
}
