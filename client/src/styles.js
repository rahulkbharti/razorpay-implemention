const BRAND = '#3b5bdb';

const STATUS_COLORS = {
  active: ['#e6fcf5', '#087f5b'],
  authenticated: ['#e7f5ff', '#1971c2'],
  pending: ['#fff9db', '#e67700'],
  halted: ['#fff5f5', '#c92a2a'],
};

const tab = {
  padding: '10px 16px',
  border: 0,
  background: 'none',
  color: '#495057',
  fontSize: 15,
  cursor: 'pointer',
};

export const styles = {
  page: { fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '32px auto', padding: '0 16px', color: '#212529' },
  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid #dee2e6', marginBottom: 24 },
  tab: (on) => (on ? { ...tab, boxShadow: `inset 0 -2px 0 ${BRAND}`, color: BRAND, fontWeight: 600 } : tab),
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 },
  toggle: { display: 'inline-flex', background: '#f1f3f5', borderRadius: 8, padding: 4 },
  toggleBtn: (on) => ({
    padding: '6px 14px',
    border: 0,
    borderRadius: 6,
    background: on ? '#fff' : 'transparent',
    boxShadow: on ? '0 1px 2px rgba(0,0,0,.12)' : 'none',
    fontSize: 14,
    cursor: 'pointer',
  }),
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 },
  card: { border: '1px solid #dee2e6', borderRadius: 12, padding: 24 },
  price: { fontSize: 28, fontWeight: 700, margin: '12px 0 20px' },
  per: { fontSize: 15, fontWeight: 400, color: '#868e96' },
  btn: (disabled) => ({
    width: '100%',
    padding: '12px 0',
    border: 0,
    borderRadius: 8,
    background: BRAND,
    color: '#fff',
    fontSize: 16,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  }),
  panel: { border: '1px solid #dee2e6', borderRadius: 12, padding: 20, marginBottom: 32, background: '#f8f9fa' },
  panelHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  badge: (status) => {
    const [bg, fg] = STATUS_COLORS[status] ?? ['#f1f3f5', '#495057'];
    return { marginLeft: 8, padding: '2px 8px', borderRadius: 999, background: bg, color: fg, fontSize: 12, fontWeight: 600 };
  },
  muted: { color: '#495057', margin: '8px 0 0', fontSize: 14 },
  linkBtn: { background: 'none', border: 0, padding: 0, color: '#c92a2a', fontSize: 14, cursor: 'pointer' },
  tableWrap: { overflowX: 'auto', marginTop: 16 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #dee2e6', color: '#868e96', fontWeight: 500 },
  td: { padding: '6px 8px', borderBottom: '1px solid #f1f3f5', whiteSpace: 'nowrap' },
  notice: (ok) => ({
    marginTop: 24,
    padding: 12,
    borderRadius: 8,
    background: ok ? '#e6fcf5' : '#fff5f5',
    color: ok ? '#087f5b' : '#c92a2a',
  }),
};
