import { useEffect, useState } from 'react';
import { api } from './api.js';
import { loadRazorpay } from './useRazorpay.js';
import { styles } from './styles.js';
import OneTime from './OneTime.jsx';
import Subscriptions from './Subscriptions.jsx';
import Admin from './Admin.jsx';

const TABS = { subscriptions: 'Subscriptions', 'one-time': 'One-time', admin: 'Admin' };

export default function App() {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('subscriptions');

  useEffect(() => {
    loadRazorpay().catch(() => {}); // preload
  }, []);

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

  return (
    <main style={styles.page}>
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
          {!config && !error && <p>Loading…</p>}
          {config && (tab === 'subscriptions' ? <Subscriptions config={config} /> : <OneTime config={config} />)}
        </>
      )}
    </main>
  );
}
