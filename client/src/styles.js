const BRAND = '#3b5bdb';

const STATUS_COLORS = {
  active: ['#e6fcf5', '#087f5b'],
  authenticated: ['#e7f5ff', '#1971c2'],
  pending: ['#fff9db', '#e67700'],
  halted: ['#fff5f5', '#c92a2a'],
  draft: ['#fff9db', '#e67700'],
};
const GRAY = ['#f1f3f5', '#495057'];

const smallBtn = {
  padding: '7px 12px',
  border: '1px solid #ced4da',
  borderRadius: 6,
  background: '#fff',
  color: '#212529',
  fontSize: 14,
  cursor: 'pointer',
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
    const [bg, fg] = STATUS_COLORS[status] ?? GRAY;
    return { marginLeft: 8, padding: '2px 8px', borderRadius: 999, background: bg, color: fg, fontSize: 12, fontWeight: 600 };
  },
  featureList: { listStyle: 'none', padding: 0, margin: '20px 0 0', fontSize: 14, lineHeight: 1.9 },
  feature: (on) => ({ color: on ? '#212529' : '#adb5bd' }),
  muted: { color: '#495057', margin: '8px 0 0', fontSize: 14 },
  linkBtn: { background: 'none', border: 0, padding: 0, color: '#c92a2a', fontSize: 14, cursor: 'pointer' },
  tableWrap: { overflowX: 'auto', marginTop: 16 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #dee2e6', color: '#868e96', fontWeight: 500 },
  td: { padding: '6px 8px', borderBottom: '1px solid #f1f3f5', whiteSpace: 'nowrap' },
  // Admin
  section: { margin: '28px 0 12px', fontSize: 16 },
  form: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#495057' },
  check: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14 },
  input: { padding: '7px 10px', border: '1px solid #ced4da', borderRadius: 6, fontSize: 14, fontFamily: 'inherit' },
  smallBtn,
  primaryBtn: { ...smallBtn, background: BRAND, borderColor: BRAND, color: '#fff' },
  dangerBtn: { ...smallBtn, color: '#c92a2a' },
  tdWrap: { padding: '6px 8px', borderBottom: '1px solid #f1f3f5' },
  key: { fontFamily: 'ui-monospace, monospace', fontSize: 13, color: '#495057' },
  code: {
    background: '#f1f3f5',
    padding: 12,
    borderRadius: 8,
    fontSize: 13,
    overflowX: 'auto',
    margin: 0,
  },
  chip: (status, on) => {
    const [bg, fg] = STATUS_COLORS[status] ?? GRAY;
    return {
      margin: '2px 6px 2px 0',
      padding: '3px 10px',
      border: `1px solid ${on ? fg : 'transparent'}`,
      borderRadius: 999,
      background: bg,
      color: fg,
      fontSize: 12,
      fontWeight: 600,
      whiteSpace: 'nowrap',
      cursor: 'pointer',
    };
  },
  toast: (ok) => ({
    position: 'fixed',
    left: 16,
    right: 16,
    bottom: 16,
    maxWidth: 688,
    margin: '0 auto',
    padding: 12,
    borderRadius: 8,
    background: ok ? '#e6fcf5' : '#fff5f5',
    color: ok ? '#087f5b' : '#c92a2a',
    boxShadow: '0 4px 16px rgba(0,0,0,.15)',
    cursor: 'pointer',
  }),
  notice: (ok) => ({
    marginTop: 24,
    padding: 12,
    borderRadius: 8,
    background: ok ? '#e6fcf5' : '#fff5f5',
    color: ok ? '#087f5b' : '#c92a2a',
  }),
};
