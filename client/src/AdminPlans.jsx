import { useState } from 'react';
import { formatLimit, rupees } from './api.js';
import { styles } from './styles.js';

const PER = { monthly: 'mo', yearly: 'yr' };
const SECTION = { boolean: 'features', limit: 'limits' };

export default function AdminPlans({ plans, features, call, run, busy }) {
  const [selectedId, setSelectedId] = useState(null);
  const [newPlan, setNewPlan] = useState({ key: '', name: '' });

  // The server sends every version, newest first within each plan.
  const groups = [];
  for (const p of plans) {
    const group = groups.find((g) => g.key === p.key);
    if (group) group.versions.push(p);
    else groups.push({ key: p.key, versions: [p] });
  }
  const selected = plans.find((p) => p.id === selectedId);
  const versionsOf = (key) => groups.find((g) => g.key === key).versions;

  async function create(e) {
    e.preventDefault();
    const plan = await run(() => call('/plans', newPlan), `Created ${newPlan.key} v1 as a draft`);
    if (plan) {
      setNewPlan({ key: '', name: '' });
      setSelectedId(plan.id);
    }
  }

  return (
    <>
      <p style={styles.muted}>
        A draft can be edited freely. Publishing makes it the version new customers buy and locks its features. To
        change them, create a new version: customers on the old one keep what they paid for.
      </p>

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Plan</th>
              <th style={styles.th}>Versions</th>
              <th style={styles.th}>Selling at</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(({ key, versions }) => {
              const live = versions.find((v) => v.status === 'active');
              return (
                <tr key={key}>
                  <td style={styles.td}>
                    <strong>{(live ?? versions[0]).name}</strong> <code style={styles.key}>{key}</code>
                    {live && !live.isPublic && <span style={styles.badge()}>hidden</span>}
                  </td>
                  <td style={styles.tdWrap}>
                    {versions.map((v) => (
                      <button key={v.id} style={styles.chip(v.status, v.id === selectedId)} onClick={() => setSelectedId(v.id)}>
                        v{v.version} · {v.status}
                      </button>
                    ))}
                  </td>
                  <td style={styles.td}>{live ? sellingAt(live) : 'Not for sale'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <form style={{ ...styles.form, marginTop: 16 }} onSubmit={create}>
        <label style={styles.field}>
          Key
          <input
            style={styles.input}
            placeholder="enterprise"
            pattern="[a-z][a-z0-9_]*"
            title="Lowercase letters, digits and _, starting with a letter"
            value={newPlan.key}
            onChange={(e) => setNewPlan((p) => ({ ...p, key: e.target.value }))}
            required
          />
        </label>
        <label style={styles.field}>
          Name
          <input
            style={styles.input}
            placeholder="Enterprise"
            value={newPlan.name}
            onChange={(e) => setNewPlan((p) => ({ ...p, name: e.target.value }))}
            required
          />
        </label>
        <button style={styles.primaryBtn} disabled={busy}>
          New plan
        </button>
      </form>

      {selected ? (
        <PlanEditor
          key={selected.id}
          plan={selected}
          versions={versionsOf(selected.key)}
          features={features}
          call={call}
          run={run}
          busy={busy}
          onSelect={setSelectedId}
        />
      ) : (
        <p style={{ ...styles.muted, marginTop: 24 }}>Pick a version above to edit it.</p>
      )}
    </>
  );
}

function sellingAt(plan) {
  const prices = plan.prices.filter((p) => p.isActive);
  return prices.length ? prices.map((p) => `${rupees(p.amount)}/${PER[p.period]}`).join(' · ') : 'Free';
}

function PlanEditor({ plan, versions, features, call, run, busy, onSelect }) {
  const locked = plan.status !== 'draft';
  const label = `${plan.key} v${plan.version}`;
  const live = versions.find((v) => v.status === 'active');
  const hasDraft = versions.some((v) => v.status === 'draft');

  const [details, setDetails] = useState({ name: plan.name, description: plan.description, isPublic: plan.isPublic });
  const [values, setValues] = useState(() =>
    Object.fromEntries(
      features.map((f) => [
        f.key,
        f.type === 'boolean' ? plan.entitlements.features[f.key] === true : (plan.entitlements.limits[f.key] ?? 0),
      ])
    )
  );
  const [price, setPrice] = useState({ period: 'monthly', rupees: '' });
  const setValue = (key, value) => setValues((v) => ({ ...v, [key]: value }));

  function body() {
    if (locked) return details;
    const entitlements = { features: {}, limits: {} };
    for (const f of features) entitlements[SECTION[f.type]][f.key] = values[f.key];
    return { ...details, entitlements };
  }

  function save(e) {
    e.preventDefault();
    run(() => call(`/plans/${plan.id}`, body(), 'PATCH'));
  }

  function publish() {
    const replaces = live ? ` ${live.key} v${live.version} is archived, and customers on it keep it.` : '';
    if (!window.confirm(`Publish ${label}? New customers get it from now on.${replaces}`)) return;
    // Save first, so unsaved edits in the form aren't left out of what gets published.
    run(async () => {
      await call(`/plans/${plan.id}`, body(), 'PATCH');
      return call(`/plans/${plan.id}/publish`, {});
    }, `Published ${label}`);
  }

  async function newVersion() {
    const draft = await run(() => call(`/plans/${plan.id}/versions`, {}), `Created a new draft from ${label}`);
    if (draft) onSelect(draft.id);
  }

  function archive() {
    if (window.confirm(`Stop selling ${plan.name}? Customers already on ${label} keep it.`)) {
      run(() => call(`/plans/${plan.id}/archive`, {}), `Archived ${label}`);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete the draft ${label}?`)) return;
    if (await run(() => call(`/plans/${plan.id}`, undefined, 'DELETE'), `Deleted ${label}`)) onSelect(null);
  }

  async function addPrice(e) {
    e.preventDefault();
    const amount = Math.round(Number(price.rupees) * 100);
    if (await run(() => call(`/plans/${plan.id}/prices`, { period: price.period, amount }))) {
      setPrice((p) => ({ ...p, rupees: '' }));
    }
  }

  function removePrice(p) {
    if (window.confirm(`Stop selling the ${p.period} price? Customers already paying it keep their subscription.`)) {
      run(() => call(`/prices/${p.id}`, undefined, 'DELETE'));
    }
  }

  return (
    <section style={{ ...styles.panel, marginTop: 32, marginBottom: 80 }}>
      <div style={styles.panelHead}>
        <h2 style={{ margin: 0 }}>
          {plan.name} <span style={styles.per}>{label}</span>
          <span style={styles.badge(plan.status)}>{plan.status}</span>
        </h2>
        <div style={styles.form}>
          {plan.status === 'draft' && (
            <>
              <button style={styles.primaryBtn} disabled={busy} onClick={publish}>
                Publish
              </button>
              <button style={styles.dangerBtn} disabled={busy} onClick={remove}>
                Delete draft
              </button>
            </>
          )}
          {plan.status !== 'draft' && (
            <button
              style={styles.smallBtn}
              disabled={busy || hasDraft}
              title={hasDraft ? 'This plan already has a draft' : undefined}
              onClick={newVersion}
            >
              New version
            </button>
          )}
          {plan.status === 'active' && (
            <button style={styles.dangerBtn} disabled={busy} onClick={archive}>
              Archive
            </button>
          )}
        </div>
      </div>

      <form onSubmit={save}>
        <h3 style={styles.section}>Details</h3>
        <div style={styles.form}>
          <label style={styles.field}>
            Name
            <input
              style={styles.input}
              value={details.name}
              onChange={(e) => setDetails((d) => ({ ...d, name: e.target.value }))}
              required
            />
          </label>
          <label style={{ ...styles.field, flex: 1, minWidth: 180 }}>
            Description
            <input
              style={styles.input}
              value={details.description}
              onChange={(e) => setDetails((d) => ({ ...d, description: e.target.value }))}
            />
          </label>
          <label style={{ ...styles.check, paddingBottom: 8 }}>
            <input
              type="checkbox"
              checked={details.isPublic}
              onChange={(e) => setDetails((d) => ({ ...d, isPublic: e.target.checked }))}
            />
            On pricing page
          </label>
        </div>

        <h3 style={styles.section}>Features & limits</h3>
        {locked && (
          <p style={{ ...styles.muted, marginBottom: 8 }}>
            Locked: customers on {label} keep exactly this. Create a new version to change it.
          </p>
        )}
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <tbody>
              {features.map((f) => (
                <tr key={f.key}>
                  <td style={styles.td}>
                    {f.name} <code style={styles.key}>{f.key}</code>
                  </td>
                  <td style={styles.td}>
                    {f.type === 'boolean' ? (
                      <label style={styles.check}>
                        <input
                          type="checkbox"
                          disabled={locked}
                          checked={values[f.key]}
                          onChange={(e) => setValue(f.key, e.target.checked)}
                        />
                        {values[f.key] ? 'On' : 'Off'}
                      </label>
                    ) : locked ? (
                      formatLimit(values[f.key])
                    ) : (
                      <LimitInput value={values[f.key]} onChange={(v) => setValue(f.key, v)} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <button style={{ ...styles.primaryBtn, marginTop: 16 }} disabled={busy}>
          Save
        </button>
      </form>

      <h3 style={styles.section}>Stored JSON</h3>
      <pre style={styles.code}>{JSON.stringify(plan.entitlements, null, 2)}</pre>
      <p style={styles.muted}>Only what the plan grants is stored; a missing key means off / 0.</p>

      <h3 style={styles.section}>Prices</h3>
      {plan.prices.length === 0 ? (
        <p style={styles.muted}>No prices, so this plan is free.</p>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Period</th>
                <th style={styles.th}>Amount</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Razorpay plan</th>
                <th style={styles.th} />
              </tr>
            </thead>
            <tbody>
              {plan.prices.map((p) => (
                <tr key={p.id} style={p.isActive ? undefined : { color: '#adb5bd' }}>
                  <td style={styles.td}>{p.period}</td>
                  <td style={styles.td}>{rupees(p.amount)}</td>
                  <td style={styles.td}>{p.isActive ? 'Selling' : 'Retired'}</td>
                  <td style={styles.td}>{p.razorpayPlanId ?? 'made on first subscribe'}</td>
                  <td style={styles.td}>
                    {p.isActive && plan.status !== 'archived' && (
                      <button style={styles.dangerBtn} disabled={busy} onClick={() => removePrice(p)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {plan.status !== 'archived' && (
        <>
          <form style={{ ...styles.form, marginTop: 16 }} onSubmit={addPrice}>
            <label style={styles.field}>
              Period
              <select
                style={styles.input}
                value={price.period}
                onChange={(e) => setPrice((p) => ({ ...p, period: e.target.value }))}
              >
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </label>
            <label style={styles.field}>
              Amount (₹)
              <input
                type="number"
                min="1"
                step="0.01"
                style={{ ...styles.input, width: 120 }}
                value={price.rupees}
                onChange={(e) => setPrice((p) => ({ ...p, rupees: e.target.value }))}
                required
              />
            </label>
            <button style={styles.primaryBtn} disabled={busy}>
              Set price
            </button>
          </form>
          <p style={styles.muted}>
            Replaces the current price for that period. Customers already paying the old one keep paying it.
            {plan.status === 'draft' && ' A draft’s prices go on sale when you publish it.'}
          </p>
        </>
      )}
    </section>
  );
}

function LimitInput({ value, onChange }) {
  const unlimited = value === -1;
  return (
    <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center' }}>
      <input
        type="number"
        min="0"
        step="1"
        style={{ ...styles.input, width: 110 }}
        disabled={unlimited}
        value={unlimited ? '' : value}
        onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value)) || 0))}
      />
      <label style={styles.check}>
        <input type="checkbox" checked={unlimited} onChange={(e) => onChange(e.target.checked ? -1 : 0)} />
        Unlimited
      </label>
    </span>
  );
}
