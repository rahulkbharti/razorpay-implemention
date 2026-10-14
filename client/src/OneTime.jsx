import { useState } from 'react';
import { api, rupees } from './api.js';
import { openCheckout } from './useRazorpay.js';
import { styles } from './styles.js';

export default function OneTime({ config }) {
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);

  async function pay(productId) {
    setBusy(productId);
    setResult(null);
    try {
      const order = await api('/api/orders', { productId });
      const response = await openCheckout(
        {
          key: config.keyId,
          order_id: order.orderId,
          amount: order.amount,
          currency: order.currency,
          name: 'My SaaS',
          description: order.name,
          theme: { color: '#3b5bdb' },
        },
        (msg) => setResult({ ok: false, msg })
      );
      if (!response) return; // closed without paying

      const v = await api('/api/payments/verify', response);
      setResult({ ok: true, msg: `Payment successful — ${v.paymentId}` });
    } catch (e) {
      setResult({ ok: false, msg: e.message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h1>Buy once</h1>
      <div style={styles.grid}>
        {Object.entries(config.products).map(([id, p]) => (
          <div key={id} style={styles.card}>
            <h2 style={{ margin: 0 }}>{p.name}</h2>
            <p style={styles.price}>{rupees(p.amount)}</p>
            <button style={styles.btn(!!busy)} disabled={!!busy} onClick={() => pay(id)}>
              {busy === id ? 'Processing…' : 'Pay now'}
            </button>
          </div>
        ))}
      </div>

      {result && <p style={styles.notice(result.ok)}>{result.msg}</p>}
    </>
  );
}
