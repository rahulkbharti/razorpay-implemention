import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { styles } from './styles.js';
import AdminPlans from './AdminPlans.jsx';
import AdminFeatures from './AdminFeatures.jsx';

const SECTIONS = { plans: 'Plans', features: 'Features' };

// Until there are user accounts, the admin API is guarded by ADMIN_TOKEN from server/.env.
// Kept for this tab session only.
const TOKEN_KEY = 'adminToken';
function savedToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function saveToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage blocked — you'll just be asked for the token again after a reload
  }
}

export default function Admin() {
  const [token, setToken] = useState(savedToken);
  const [section, setSection] = useState('plans');
  const [features, setFeatures] = useState(null);
  const [plans, setPlans] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const call = useCallback((path, body, method) => api(`/api/admin${path}`, body, { method, token }), [token]);

  const lock = useCallback((msg) => {
    saveToken(null);
    setToken(null);
    setFeatures(null);
    setPlans(null);
    setNotice(msg ? { ok: false, msg } : null);
  }, []);

  const reload = useCallback(async () => {
    try {
      const [f, p] = await Promise.all([call('/features'), call('/plans')]);
      setFeatures(f);
      setPlans(p);
    } catch (e) {
      if (e.status === 401 || e.status === 503) lock(e.message);
      else setNotice({ ok: false, msg: e.message });
    }
  }, [call, lock]);

  useEffect(() => {
    if (token) reload();
  }, [token, reload]);

  // Success messages fade; errors stay until clicked or the next action.
  useEffect(() => {
    if (!notice?.ok) return;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);

  // Runs an admin call, then reloads everything. Resolves with the call's result, or null if it failed.
  const run = useCallback(
    async (fn, okMsg = 'Saved') => {
      setBusy(true);
      setNotice(null);
      try {
        const result = await fn();
        await reload();
        setNotice({ ok: true, msg: okMsg });
        return result;
      } catch (e) {
        if (e.status === 401) lock(e.message);
        else setNotice({ ok: false, msg: e.message });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [reload, lock]
  );

  if (!token) {
    return (
      <Login
        error={notice?.msg}
        onSubmit={(t) => {
          saveToken(t);
          setNotice(null);
          setToken(t);
        }}
      />
    );
  }

  const props = { features, call, run, busy };
  return (
    <>
      <div style={styles.header}>
        <h1 style={{ margin: 0 }}>Plans & features</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={styles.toggle}>
            {Object.entries(SECTIONS).map(([id, label]) => (
              <button key={id} style={styles.toggleBtn(section === id)} onClick={() => setSection(id)}>
                {label}
              </button>
            ))}
          </div>
          <button style={styles.smallBtn} onClick={() => lock()}>
            Lock
          </button>
        </div>
      </div>

      {!features || !plans ? (
        <p>Loading…</p>
      ) : section === 'plans' ? (
        <AdminPlans plans={plans} {...props} />
      ) : (
        <AdminFeatures {...props} />
      )}

      {notice && (
        <p style={styles.toast(notice.ok)} onClick={() => setNotice(null)}>
          {notice.msg}
        </p>
      )}
    </>
  );
}

function Login({ error, onSubmit }) {
  const [value, setValue] = useState('');
  return (
    <form
      style={styles.panel}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value.trim());
      }}
    >
      <h2 style={{ margin: 0 }}>Admin</h2>
      <p style={styles.muted}>Enter the ADMIN_TOKEN from server/.env to manage plans and features.</p>
      <div style={{ ...styles.form, marginTop: 16 }}>
        <input
          type="password"
          style={{ ...styles.input, flex: 1, minWidth: 200 }}
          placeholder="Admin token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          required
        />
        <button style={styles.primaryBtn}>Unlock</button>
      </div>
      {error && <p style={styles.notice(false)}>{error}</p>}
    </form>
  );
}
