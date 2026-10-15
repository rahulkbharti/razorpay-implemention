import { useEffect, useState } from 'react';
import { formatLimit } from './api.js';
import { styles } from './styles.js';

const SECTION = { boolean: 'features', limit: 'limits' };
const show = (f, value) => (f.type === 'boolean' ? (value ? 'On' : 'Off') : formatLimit(value));

// One workspace's overrides: features and limits that differ from its plan (e.g. a negotiated deal).
// An override applies whatever plan the workspace is on, until it's removed here.
export default function AdminOverrides({ tenantId, call, run, busy, onClose }) {
  const [data, setData] = useState(null);
  const [values, setValues] = useState({}); // key → override value; a missing key follows the plan
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    call(`/tenants/${tenantId}/overrides`)
      .then((d) => {
        setData(d);
        setNote(d.note);
        setValues(Object.fromEntries(d.features.filter((f) => f.override !== null).map((f) => [f.key, f.override])));
      })
      .catch((e) => setError(e.message));
  }, [tenantId, call]);

  const set = (key, value) =>
    setValues((v) => {
      const next = { ...v };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });

  async function save(e) {
    e.preventDefault();
    const overrides = { features: {}, limits: {} };
    for (const f of data.features) if (f.key in values) overrides[SECTION[f.type]][f.key] = values[f.key];
    await run(() => call(`/tenants/${tenantId}/overrides`, { overrides, note }, 'PUT'), 'Overrides saved');
  }

  if (error) return <p style={styles.notice(false)}>{error}</p>;
  if (!data) return <p>Loading…</p>;

  return (
    <form style={{ ...styles.panel, marginTop: 24, marginBottom: 80 }} onSubmit={save}>
      <div style={styles.panelHead}>
        <h2 style={{ margin: 0 }}>
          {data.tenant.name} <span style={styles.per}>overrides</span>
        </h2>
        <button type="button" style={styles.smallBtn} onClick={onClose}>
          Close
        </button>
      </div>
      <p style={styles.muted}>
        On <strong>{data.plan?.name ?? 'no'}</strong> plan. An override replaces the plan's value for this workspace only,
        whichever plan it's on, until you set it back to “Same as plan”.
      </p>

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Feature</th>
              <th style={styles.th}>Plan</th>
              <th style={styles.th}>For this workspace</th>
            </tr>
          </thead>
          <tbody>
            {data.features.map((f) => {
              const overridden = f.key in values;
              return (
                <tr key={f.key} style={overridden ? { background: '#fff9db' } : undefined}>
                  <td style={styles.td}>
                    {f.name} <code style={styles.key}>{f.key}</code>
                  </td>
                  <td style={styles.td}>{show(f, f.planValue)}</td>
                  <td style={styles.td}>
                    {f.type === 'boolean' ? (
                      <select
                        style={styles.input}
                        aria-label={`${f.name} override`}
                        value={overridden ? String(values[f.key]) : ''}
                        onChange={(e) => set(f.key, e.target.value === '' ? undefined : e.target.value === 'true')}
                      >
                        <option value="">Same as plan</option>
                        <option value="true">On</option>
                        <option value="false">Off</option>
                      </select>
                    ) : (
                      <LimitOverride
                        name={f.name}
                        value={values[f.key]}
                        planValue={f.planValue}
                        onChange={(v) => set(f.key, v)}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <label style={{ ...styles.field, marginTop: 16 }}>
        Note (why, e.g. “Annual deal, approved by Rahul”)
        <input style={styles.input} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button style={{ ...styles.primaryBtn, marginTop: 16 }} disabled={busy}>
        Save overrides
      </button>
    </form>
  );
}

function LimitOverride({ name, value, planValue, onChange }) {
  const custom = value !== undefined;
  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <select
        style={styles.input}
        aria-label={`${name} override`}
        value={custom ? 'custom' : ''}
        onChange={(e) => onChange(e.target.value === 'custom' ? (planValue === -1 ? -1 : planValue) : undefined)}
      >
        <option value="">Same as plan</option>
        <option value="custom">Custom</option>
      </select>
      {custom && (
        <>
          <input
            type="number"
            min="0"
            step="1"
            style={{ ...styles.input, width: 110 }}
            aria-label={`${name} custom limit`}
            disabled={value === -1}
            value={value === -1 ? '' : value}
            onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value)) || 0))}
          />
          <label style={styles.check}>
            <input type="checkbox" checked={value === -1} onChange={(e) => onChange(e.target.checked ? -1 : planValue === -1 ? 0 : planValue)} />
            Unlimited
          </label>
        </>
      )}
    </span>
  );
}
