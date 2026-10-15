import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { loadRazorpay } from './useRazorpay.js';
import { styles } from './styles.js';
import Auth from './Auth.jsx';
import Subscriptions from './Subscriptions.jsx';
import Workspace from './Workspace.jsx';
import Admin from './Admin.jsx';

const TABS = { workspace: 'Workspace', subscriptions: 'Pricing & billing', admin: 'Admin' };

export default function App() {
  const [config, setConfig] = useState(null);
  const [me, setMe] = useState(undefined); // undefined while loading, null when logged out
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('workspace');

  // The logged-in user, their workspace and the plan its features come from.
  const loadMe = useCallback(
    () =>
      api('/api/me')
        .then(setMe)
        .catch((e) => (e.status === 401 ? setMe(null) : setError(e.message))),
    []
  );

  useEffect(() => {
    loadMe();
    loadRazorpay().catch(() => {}); // preload
  }, [loadMe]);

  // Reload on every tab switch so plan changes made in Admin show up straight away.
  useEffect(() => {
    if (tab === 'admin') return;
    api('/api/config')
      .then((c) => {
        setConfig(c);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [tab]);

  async function logout() {
    await api('/api/auth/logout', {}).catch(() => {});
    setMe(null);
  }

  return (
    <main style={styles.page}>
      {me && (
        <div style={styles.account}>
          <span>
            <strong>{me.tenant.name}</strong> · {me.user.email} · {me.plan?.name ?? 'No'} plan
          </span>
          <button style={styles.textBtn} onClick={logout}>
            Log out
          </button>
        </div>
      )}

      <nav style={styles.tabs}>
        {Object.entries(TABS).map(([id, label]) => (
          <button key={id} style={styles.tab(tab === id)} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === 'admin' ? (
        <Admin />
      ) : (
        <>
          {error && <p style={styles.notice(false)}>{error}</p>}
          {(!config || me === undefined) && !error && <p>Loading…</p>}
          {config &&
            me !== undefined &&
            (!me ? (
              <Auth onDone={loadMe} />
            ) : tab === 'workspace' ? (
              <Workspace config={config} me={me} onUpgrade={() => setTab('subscriptions')} />
            ) : (
              <Subscriptions config={config} me={me} onChange={loadMe} />
            ))}
        </>
      )}
    </main>
  );
}
