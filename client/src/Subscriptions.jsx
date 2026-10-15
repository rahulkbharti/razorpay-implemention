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
  const [preview, setPreview] = useState(null); // a plan change waiting for confirmation
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

  const checkoutOptions = (description) => ({
    key: config.keyId,
    name: 'Libspace',
    description,
    prefill: { name: me.user.name, email: me.user.email, contact: me.user.phone ?? undefined },
    theme: { color: '#3b5bdb' },
  });
  const onFailedAttempt = (msg) => setResult({ ok: false, msg });

  // Runs a billing action: busy flag, then a success notice (and a refresh) when it returns a message.
  async function run(key, fn) {
    setBusy(key);
    setResult(null);
    try {
      const msg = await fn();
      if (msg) {
        await refresh();
        setResult({ ok: true, msg });
      }
    } catch (e) {
      setResult({ ok: false, msg: e.message });
    } finally {
      setBusy(null);
    }
  }

  // Pays for the first period now, or with trial: true starts the free trial the plan offers.
  function subscribe(priceId, { trial = false } = {}) {
    run(trial ? `${priceId}-trial` : priceId, async () => {
      const s = await api('/api/subscriptions', { priceId, method, trial });
      const checkout = checkoutOptions(`${s.name} — ${rupees(s.amount)} / ${PER[s.period]}`);

      if (s.method === 'auto') {
        // No amount or order: Razorpay takes them from the plan. With a trial this only sets up the mandate.
        if (s.trialDays) checkout.description = `${s.trialDays}-day free trial, then ${checkout.description}`;
        const response = await openCheckout({ ...checkout, subscription_id: s.subscriptionId }, onFailedAttempt);
        if (!response) return null; // closed without finishing
        await api('/api/subscriptions/verify', response);
      } else if (s.orderId) {
        // Manual: pay the first period now.
        const response = await openCheckout(
          { ...checkout, order_id: s.orderId, amount: s.amount, currency: s.currency },
          onFailedAttempt
        );
        if (!response) return null;
        await api(`/api/invoices/${s.invoiceId}/verify`, response);
      }
      // Otherwise it's a manual trial, which starts without paying anything.
      polls.current = 0;
      return s.trialDays ? `Your ${s.trialDays}-day ${s.name} trial has started` : `Subscribed to ${s.name}`;
    });
  }

  // Razorpay can't change the plan of a UPI Autopay, so such a change comes back as a new mandate
  // to approve (with the prorated difference as an upfront amount, for an upgrade). Returns false
  // if the customer closed Checkout: then nothing has changed.
  async function approveMandate(m) {
    const autopay = `autopay ${rupees(m.amount)} / ${PER[m.period]} from ${date(m.startsAt)}`;
    const response = await openCheckout(
      {
        ...checkoutOptions(m.upfront > 0 ? `Pay ${rupees(m.upfront)} now, then ${autopay}` : `New ${autopay}`),
        subscription_id: m.subscriptionId,
      },
      onFailedAttempt
    );
    if (!response) return false;
    await api('/api/subscription/mandate/verify', response);
    return true;
  }

  // Changing plans: the server says what it would cost and when, the customer confirms.
  function previewChange(priceId) {
    run(priceId, async () => {
      setPreview({ priceId, ...(await api('/api/subscription/change/preview', { priceId })) });
      return null;
    });
  }

  function confirmChange() {
    const { priceId, plan, at, when } = preview;
    const done = when === 'period_end' ? `Switching to ${plan.name} on ${date(at)}` : `You're now on ${plan.name}`;
    run('change', async () => {
      const r = await api('/api/subscription/change', { priceId });
      setPreview(null);
      if (r.mandate) {
        if (!(await approveMandate(r.mandate))) throw new Error(`Plan not changed — the new autopay wasn't approved.`);
        return done;
      }
      if (r.invoiceId) {
        const response = await openCheckout(
          {
            ...checkoutOptions(`Upgrade to ${r.name} for the rest of this period`),
            order_id: r.orderId,
            amount: r.amount,
            currency: r.currency,
          },
          onFailedAttempt
        );
        if (!response) {
          await refresh();
          // Autopay schedules the new plan at Razorpay before the charge, so it's on for the next cycle.
          throw new Error(
            sub.collectionMethod === 'auto'
              ? `Upgrade not paid. ${r.name} is scheduled from your next renewal — cancel the change below if you don't want it.`
              : `Upgrade not paid — you're still on ${sub.name}.`
          );
        }
        await api(`/api/invoices/${r.invoiceId}/verify`, response);
      }
      return done;
    });
  }

  function cancelChange() {
    run('cancel-change', async () => {
      const r = await api('/api/subscription/change/cancel', {});
      if (r.mandate && !(await approveMandate(r.mandate))) {
        throw new Error("Change not cancelled — the autopay for your current plan wasn't approved.");
      }
      return 'Scheduled change cancelled';
    });
  }

  function switchMethod(target) {
    if (
      target === 'manual' &&
      !window.confirm(`Stop autopay? Nothing changes until ${date(sub.currentPeriodEnd)}; before then we'll send you a payment link instead.`)
    ) {
      return;
    }
    run('method', async () => {
      const r = await api('/api/subscription/method', { method: target });
      if (target === 'manual') return "Autopay stopped. We'll send a payment link before your next renewal.";
      // A mandate whose first charge is when the current (already paid) period ends.
      const response = await openCheckout(
        {
          ...checkoutOptions(`Autopay from ${date(r.startsAt)}: ${rupees(r.amount)} / ${PER[r.period]}`),
          subscription_id: r.subscriptionId,
        },
        onFailedAttempt
      );
      if (!response) throw new Error("Autopay wasn't set up — you're still on Pay each time.");
      await api('/api/subscription/method/verify', response);
      return `Autopay is on. The first charge is on ${date(r.startsAt)}.`;
    });
  }

  async function cancel() {
    // Keep what's paid for (or the rest of a manual trial). An autopay trial or a past-due
    // subscription ends now.
    const atCycleEnd = sub.status === 'active' || (sub.collectionMethod === 'manual' && sub.status === 'trialing');
    const question = atCycleEnd
      ? `Cancel your subscription? You keep ${sub.name} until ${date(sub.currentPeriodEnd)}.`
      : 'Cancel your subscription? The workspace goes back to the free plan now.';
    if (!window.confirm(question)) return;
    run('cancel', async () => {
      setSub((await api('/api/subscription/cancel', { atCycleEnd })).subscription);
      await onChange();
      return null;
    });
  }

  const live = sub && LIVE.includes(sub.status);
  const canChange = live && canBill && sub.status !== 'past_due' && !sub.cancelAtPeriodEnd;
  const currentKey = me.plan?.key;
  // A plan with no prices is free and shows under both periods.
  const plans = config.plans
    .map((p) => ({ ...p, price: p.prices.find((pr) => pr.period === period) }))
    .filter((p) => p.price || p.prices.length === 0);

  return (
    <>
      {sub && (
        <CurrentSubscription
          sub={sub}
          busy={!!busy}
          canBill={canBill}
          onCancel={cancel}
          onCancelChange={cancelChange}
          onSwitchMethod={switchMethod}
        />
      )}

      <div style={styles.header}>
        <h1 style={{ margin: 0 }}>{live ? 'Change plan' : 'Choose a plan'}</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Toggle options={{ monthly: 'Monthly', yearly: 'Yearly' }} value={period} onChange={setPeriod} />
          {/* How a new subscription is paid. A live one switches from the panel above. */}
          {!live && <Toggle options={METHODS} value={method} onChange={setMethod} />}
        </div>
      </div>
      {!live && <p style={{ ...styles.muted, margin: '-4px 0 16px' }}>{METHOD_HELP[method]}</p>}
      {live && sub.status === 'past_due' && (
        <p style={{ ...styles.muted, margin: '-4px 0 16px' }}>Pay the overdue invoice first, then you can change plans.</p>
      )}

      {preview && (
        <ChangePanel preview={preview} sub={sub} busy={!!busy} onConfirm={confirmChange} onClose={() => setPreview(null)} />
      )}

      <div style={styles.grid}>
        {plans.map((p) => {
          const trial = !live && p.price && p.trialDays > 0 && me.trialAvailable ? p.trialDays : 0;
          let label;
          let disabled;
          let onClick = () => subscribe(p.price.id);
          if (!live) {
            const current = p.key === currentKey;
            disabled = !!busy || !p.price || current || !canBill;
            label = current ? 'Current plan' : !p.price ? 'Free forever' : 'Subscribe';
          } else {
            const current = p.price?.id === sub.priceId;
            const scheduled = p.price && sub.pendingChange?.priceId === p.price.id;
            disabled = !!busy || !canChange || !p.price || current || scheduled;
            onClick = () => previewChange(p.price.id);
            label = current
              ? 'Current plan'
              : !p.price
                ? 'Free forever'
                : scheduled
                  ? 'Scheduled'
                  : p.key === sub.planKey
                    ? `Switch to ${period}`
                    : `Switch to ${p.name}`;
          }
          if (p.price && busy === p.price.id) label = 'Processing…';
          return (
            <div key={p.key} style={styles.card}>
              <h2 style={{ margin: 0 }}>{p.name}</h2>
              {p.description && <p style={styles.muted}>{p.description}</p>}
              <p style={styles.price}>
                {p.price ? rupees(p.price.amount) : '₹0'}
                <span style={styles.per}> / {PER[period]}</span>
              </p>
              <button style={styles.btn(disabled)} disabled={disabled} onClick={onClick}>
                {label}
              </button>
              {trial > 0 && (
                <>
                  <button
                    style={styles.secondaryLinkBtn(disabled)}
                    disabled={disabled}
                    onClick={() => subscribe(p.price.id, { trial: true })}
                  >
                    {busy === `${p.price.id}-trial` ? 'Processing…' : `Start ${trial}-day free trial`}
                  </button>
                  <p style={{ ...styles.muted, fontSize: 13 }}>
                    {method === 'auto'
                      ? `Set up autopay now; the first charge is after ${trial} days.`
                      : `Nothing to pay now. We'll send a payment link before the trial ends.`}
                  </p>
                </>
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

function ChangePanel({ preview, sub, busy, onConfirm, onClose }) {
  const ref = useRef(null);
  // Braces matter: newer browsers return a promise from scrollIntoView, and React would call
  // whatever an effect returns as its cleanup.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [preview]);
  const { plan, when, amount, at, losing } = preview;
  const next = `${rupees(plan.amount)} / ${PER[plan.period]}`;
  const text =
    sub.status === 'trialing'
      ? `Switch your trial to ${plan.name} now. Nothing to pay; after the trial it's ${next}.`
      : when === 'period_end'
        ? `Switch to ${plan.name} (${next}) on ${date(at)}. You keep ${sub.name} until then.`
        : amount > 0
          ? `Upgrade to ${plan.name} now: pay ${rupees(amount)} today for the rest of this period, then ${next}.`
          : `Upgrade to ${plan.name} now. The difference for the days left is too small to charge; then ${next}.`;
  const n = (x) => x.toLocaleString('en-IN');
  return (
    <section ref={ref} style={{ ...styles.panel, marginBottom: 16 }}>
      <strong>Change to {plan.name}</strong>
      <p style={styles.muted}>{text}</p>
      {sub.collectionMethod === 'auto' && (
        <p style={styles.muted}>With UPI Autopay you'll approve the new amount in your UPI app; the old mandate is then stopped.</p>
      )}
      {losing.features.length > 0 && <p style={styles.muted}>You'll lose: {losing.features.join(', ')}.</p>}
      {losing.limits.map((l) => (
        <p key={l.name} style={styles.muted}>
          {l.name}: you're using {n(l.used)}, {plan.name} allows {formatLimit(l.limit)}. Nothing is deleted, but you can't
          add more.
        </p>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button style={styles.primaryBtn} disabled={busy} onClick={onConfirm}>
          {when === 'now' && amount > 0 ? `Pay ${rupees(amount)} and upgrade` : 'Confirm'}
        </button>
        <button style={styles.smallBtn} onClick={onClose}>
          Keep {sub.name}
        </button>
      </div>
    </section>
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

function CurrentSubscription({ sub, busy, canBill, onCancel, onCancelChange, onSwitchMethod }) {
  const live = LIVE.includes(sub.status);
  const otherMethod = sub.collectionMethod === 'auto' ? 'manual' : 'auto';
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

      {sub.pendingChange && (
        <p style={styles.muted}>
          Switching to <strong>{sub.pendingChange.name}</strong> ({rupees(sub.pendingChange.amount)} /{' '}
          {PER[sub.pendingChange.period]}) on {date(sub.pendingChange.at)}.{' '}
          {canBill && (
            <button style={styles.textBtn} disabled={busy} onClick={onCancelChange}>
              Cancel change
            </button>
          )}
        </p>
      )}

      {live && canBill && !sub.cancelAtPeriodEnd && sub.status !== 'past_due' && (
        <p style={styles.muted}>
          {sub.collectionMethod === 'auto' ? "Don't want autopay? " : 'Rather not pay by hand each time? '}
          <button style={styles.textBtn} disabled={busy} onClick={() => onSwitchMethod(otherMethod)}>
            Switch to {METHODS[otherMethod]}
          </button>
        </p>
      )}

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
                  <td style={styles.td}>
                    {rupees(p.amount)}
                    {p.kind === 'upgrade' && <span style={styles.per}> · upgrade</span>}
                  </td>
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
      if (!manual) return `Autopay renews it on ${until}.`;
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
