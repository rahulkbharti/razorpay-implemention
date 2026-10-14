import { styles } from './styles.js';

const date = (value) =>
  value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const METHOD = { auto: 'Autopay', manual: 'Manual' };

export default function AdminTenants({ tenants }) {
  if (!tenants.length) return <p style={styles.muted}>No workspaces yet. They appear here when someone signs up.</p>;

  return (
    <>
      <p style={styles.muted}>Every customer workspace, the plan its features come from, and its latest subscription.</p>
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
                </td>
                <td style={styles.td}>
                  {t.ownerEmail}
                  {t.ownerPhone && <div style={styles.key}>{t.ownerPhone}</div>}
                </td>
                <td style={styles.td}>
                  <code style={styles.key}>{t.plan}</code>
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
    </>
  );
}
