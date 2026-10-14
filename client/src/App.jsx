import { useEffect, useState } from 'react';
import { loadRazorpay } from './useRazorpay.js';

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN')}`;

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  // When the API is down, the Vite proxy answers 502 with an empty (non-JSON) body.
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Server error (${res.status}) — is the API running on port 5000?`);
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    api('/api/config').then(setConfig).catch((e) => setResult({ ok: false, msg: e.message }));
    loadRazorpay().catch(() => {}); // preload
  }, []);

  async function pay(productId) {
    setBusy(productId);
    setResult(null);
    try {
      const Razorpay = await loadRazorpay();
      const order = await api('/api/orders', { productId });

      const rzp = new Razorpay({
        key: config.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: 'My SaaS',
        description: order.name,
        prefill: { name: '', email: '', contact: '' },
        theme: { color: '#3b5bdb' },
        handler: async (response) => {
          try {
            const v = await api('/api/payments/verify', response);
            setResult({ ok: true, msg: `Payment successful — ${v.paymentId}` });
          } catch (e) {
            setResult({ ok: false, msg: `Verification failed: ${e.message}` });
          } finally {
            setBusy(null);
          }
        },
        modal: { ondismiss: () => setBusy(null) },
      });

      rzp.on('payment.failed', (r) => {
        setResult({ ok: false, msg: r.error?.description || 'Payment failed' });
        setBusy(null);
      });

      rzp.open();
    } catch (e) {
      setResult({ ok: false, msg: e.message });
      setBusy(null);
    }
  }

  return (
    <main style={styles.page}>
      <h1>Choose a plan</h1>
      {!config && !result && <p>Loading…</p>}

      <div style={styles.grid}>
        {config &&
          Object.entries(config.products).map(([id, p]) => (
            <div key={id} style={styles.card}>
              <h2 style={{ margin: 0 }}>{p.name}</h2>
              <p style={styles.price}>{rupees(p.amount)}</p>
              <button style={styles.btn} disabled={!!busy} onClick={() => pay(id)}>
                {busy === id ? 'Processing…' : 'Pay now'}
              </button>
            </div>
          ))}
      </div>

      {result && (
        <p style={{ ...styles.alert, background: result.ok ? '#e6fcf5' : '#fff5f5', color: result.ok ? '#087f5b' : '#c92a2a' }}>
          {result.msg}
        </p>
      )}
    </main>
  );
}

const styles = {
  page: { fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '48px auto', padding: '0 16px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 },
  card: { border: '1px solid #dee2e6', borderRadius: 12, padding: 24 },
  price: { fontSize: 28, fontWeight: 700, margin: '12px 0 20px' },
  btn: { width: '100%', padding: '12px 0', border: 0, borderRadius: 8, background: '#3b5bdb', color: '#fff', fontSize: 16, cursor: 'pointer' },
  alert: { marginTop: 24, padding: 12, borderRadius: 8 },
};
