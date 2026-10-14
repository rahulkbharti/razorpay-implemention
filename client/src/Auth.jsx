import { useState } from 'react';
import { api } from './api.js';
import { styles } from './styles.js';

const EMPTY = { name: '', email: '', password: '', phone: '', workspace: '' };

export default function Auth({ onDone }) {
  const [mode, setMode] = useState('signup');
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const signup = mode === 'signup';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/auth/${mode}`, signup ? form : { email: form.email, password: form.password });
      await onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const input = (field, props) => (
    <input
      style={styles.input}
      value={form[field]}
      onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
      {...props}
    />
  );

  return (
    <form style={styles.authCard} onSubmit={submit}>
      <h2 style={{ margin: 0 }}>{signup ? 'Create your workspace' : 'Log in'}</h2>
      <p style={styles.muted}>
        {signup ? 'Plans and billing belong to the workspace, so everyone in it gets its features.' : 'Welcome back.'}
      </p>

      <div style={styles.stack}>
        {signup && (
          <label style={styles.field}>
            Your name
            {input('name', { required: true, autoComplete: 'name' })}
          </label>
        )}
        <label style={styles.field}>
          Email
          {input('email', { type: 'email', required: true, autoComplete: 'email' })}
        </label>
        <label style={styles.field}>
          Password
          {input('password', {
            type: 'password',
            required: true,
            minLength: signup ? 8 : undefined,
            autoComplete: signup ? 'new-password' : 'current-password',
          })}
        </label>
        {signup && (
          <>
            <label style={styles.field}>
              Phone (optional, for payment reminders)
              {input('phone', { type: 'tel', autoComplete: 'tel', placeholder: '+91 98765 43210' })}
            </label>
            <label style={styles.field}>
              Workspace name (optional)
              {input('workspace', { placeholder: 'Acme Pvt Ltd' })}
            </label>
          </>
        )}
      </div>

      <button style={{ ...styles.btn(busy), marginTop: 20 }} disabled={busy}>
        {busy ? 'Please wait…' : signup ? 'Create account' : 'Log in'}
      </button>
      {error && <p style={styles.notice(false)}>{error}</p>}

      <p style={{ ...styles.muted, marginTop: 16 }}>
        {signup ? 'Already have an account? ' : 'New here? '}
        <button
          type="button"
          style={styles.textBtn}
          onClick={() => {
            setMode(signup ? 'login' : 'signup');
            setError(null);
          }}
        >
          {signup ? 'Log in' : 'Create an account'}
        </button>
      </p>
    </form>
  );
}
