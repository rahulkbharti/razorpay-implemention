import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { styles } from './styles.js';

const date = (value) =>
  value ? new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never';

// Keys for the workspace's own code to call the public API. Each call counts towards API calls / month.
export default function ApiKeys({ canAdmin, onUsageChange }) {
  const [keys, setKeys] = useState(null);
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null); // { name, key }: shown once, right after creating
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => setKeys(await api('/api/api-keys')), []);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const k = await api('/api/api-keys', { name });
      setCreated(k);
      setCopied(false);
      setName('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k) {
    if (!window.confirm(`Revoke “${k.name}”? Anything still using ${k.hint} stops working straight away.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/api-keys/${k.id}`, undefined, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      setError('Could not copy — select the key and copy it by hand');
    }
  }

  const endpoint = `${window.location.origin}/api/v1/projects`;
  const sample = `curl ${endpoint} \\\n  -H "Authorization: Bearer ${created?.key ?? 'sk_your_key'}"`;

  return (
    <>
      <h3 style={styles.section}>API</h3>
      <p style={{ ...styles.muted, marginTop: 0 }}>
        Call the API from your own code with a key. Every call counts towards your API calls this month.
      </p>

      {created && (
        <div style={{ ...styles.notice(true), marginTop: 12 }}>
          <strong>Copy “{created.name}” now — it won't be shown again.</strong>
          <div style={{ ...styles.listRow, borderBottom: 0 }}>
            <code style={{ ...styles.key, wordBreak: 'break-all' }}>{created.key}</code>
            <span style={{ display: 'flex', gap: 8 }}>
              <button style={styles.primaryBtn} onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button style={styles.smallBtn} onClick={() => setCreated(null)}>
                Done
              </button>
            </span>
          </div>
        </div>
      )}

      {keys?.length > 0 && (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Name</th>
                <th style={styles.th}>Key</th>
                <th style={styles.th}>Created</th>
                <th style={styles.th}>Last used</th>
                {canAdmin && <th style={styles.th} />}
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td style={styles.td}>{k.name}</td>
                  <td style={styles.td}>
                    <code style={styles.key}>{k.hint}</code>
                  </td>
                  <td style={styles.td}>{date(k.createdAt)}</td>
                  <td style={styles.td}>{date(k.lastUsedAt)}</td>
                  {canAdmin && (
                    <td style={styles.td}>
                      <button style={styles.dangerBtn} disabled={busy} onClick={() => revoke(k)}>
                        Revoke
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {keys?.length === 0 && <p style={styles.muted}>No API keys yet.</p>}

      {canAdmin ? (
        <form style={{ ...styles.form, marginTop: 12 }} onSubmit={create}>
          <input
            style={{ ...styles.input, flex: 1, minWidth: 180 }}
            placeholder="Key name, e.g. Production server"
            aria-label="Key name"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <button style={styles.primaryBtn} disabled={busy}>
            Create key
          </button>
        </form>
      ) : (
        <p style={styles.muted}>Only the workspace owner or an admin can create or revoke keys.</p>
      )}

      <p style={{ ...styles.muted, marginTop: 16 }}>Try it:</p>
      <pre style={{ ...styles.code, marginTop: 6 }}>{sample}</pre>
      <p style={styles.muted}>
        Responses include <code style={styles.key}>X-RateLimit-Remaining</code>. When the month's calls run out, the API
        answers <code style={styles.key}>429</code> until the 1st.{' '}
        <button type="button" style={styles.textBtn} onClick={onUsageChange}>
          Refresh usage
        </button>
      </p>
      {error && <p style={styles.notice(false)}>{error}</p>}
    </>
  );
}
