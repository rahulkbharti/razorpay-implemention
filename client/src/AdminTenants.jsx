import { useState } from 'react';
import { styles } from './styles.js';
import AdminOverrides from './AdminOverrides.jsx';

const date = (value) =>
  value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const METHOD = { auto: 'Autopay', manual: 'Manual' };

export default function AdminTenants({ tenants, call, run, busy }) {
  const [job, setJob] = useState(null);
  const [editing, setEditing] = useState(null); // tenant id whose overrides are open

  // The server runs this every hour; running it now is handy for testing reminders and expiry.
  async function runJob() {
    const summary = await run(() => call('/jobs/billing', {}), 'Billing job finished');
    if (summary) setJob(summary);
  }

  return (
    <>
      <div style={styles.panelHead}>
        <p style={{ ...styles.muted, margin: 0 }}>
          Every customer workspace, the plan its features come from, and its latest subscription.
        </p>
        <button style={styles.smallBtn} disabled={busy} onClick={runJob}>
          Run billing job now
        </button>
      </div>
      {job && (
        <pre style={{ ...styles.code, marginTop: 12 }}>{JSON.stringify(job, null, 2)}</pre>
      )}
      {!tenants.length && <p style={styles.muted}>No workspaces yet. They appear here when someone signs up.</p>}
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Workspace</th>
              <th style={styles.th}>Owner</th>
              <th style={styles.th}>Plan</th>
              <th style={styles.th}>Billing</th>
              <th style={styles.th}>Joined</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={t.id}>
                <td style={styles.td}>
                  <strong>{t.name}</strong>
                  <div>
                    <button style={{ ...styles.textBtn, fontSize: 13 }} onClick={() => setEditing(t.id)}>
                      Overrides
                    </button>
                  </div>
                </td>
                <td style={styles.td}>
                  {t.ownerEmail}
                  {t.ownerPhone && <div style={styles.key}>{t.ownerPhone}</div>}
                </td>
                <td style={styles.td}>
                  <code style={styles.key}>{t.plan}</code>
                  {t.hasOverrides && <span style={styles.badge('draft')}>custom</span>}
                </td>
                <td style={styles.td}>
                  {t.subscription ? (
                    <>
                      {METHOD[t.subscription.collectionMethod]}
                      <span style={styles.badge(t.subscription.cancelAtPeriodEnd ? 'cancelling' : t.subscription.status)}>
                        {t.subscription.cancelAtPeriodEnd ? 'cancelling' : t.subscription.status.replace('_', ' ')}
                      </span>
                      {['active', 'past_due'].includes(t.subscription.status) && (
                        <div style={styles.key}>until {date(t.subscription.currentPeriodEnd)}</div>
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td style={styles.td}>{date(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <AdminOverrides key={editing} tenantId={editing} call={call} run={run} busy={busy} onClose={() => setEditing(null)} />
      )}
    </>
  );
}
