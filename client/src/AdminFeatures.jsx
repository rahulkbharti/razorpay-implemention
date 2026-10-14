import { useState } from 'react';
import { styles } from './styles.js';

const EMPTY = { key: '', type: 'boolean', name: '', description: '' };
const TYPE_LABEL = { boolean: 'On / off', limit: 'Limit' };

export default function AdminFeatures({ features, call, run, busy }) {
  const [draft, setDraft] = useState(EMPTY);
  const [editing, setEditing] = useState(null); // { key, name, description }

  async function add(e) {
    e.preventDefault();
    if (await run(() => call('/features', draft), `Added "${draft.key}"`)) setDraft(EMPTY);
  }

  async function save() {
    const { key, name, description } = editing;
    if (await run(() => call(`/features/${key}`, { name, description }, 'PATCH'))) setEditing(null);
  }

  function remove(f) {
    if (window.confirm(`Delete "${f.key}"? Only possible when no plan version grants it.`)) {
      run(() => call(`/features/${f.key}`, undefined, 'DELETE'), `Deleted "${f.key}"`);
    }
  }

  const set = (field) => (e) => setDraft((d) => ({ ...d, [field]: e.target.value }));
  const edit = (field) => (e) => setEditing((d) => ({ ...d, [field]: e.target.value }));

  return (
    <>
      <p style={styles.muted}>
        Everything a plan can grant. Plans can only use keys listed here, so a typo can't slip into one. A feature
        you add shows up in every plan editor straight away.
      </p>

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Key</th>
              <th style={styles.th}>Type</th>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Description</th>
              <th style={styles.th} />
            </tr>
          </thead>
          <tbody>
            {features.map((f) =>
              editing?.key === f.key ? (
                <tr key={f.key}>
                  <td style={styles.td}>
                    <code style={styles.key}>{f.key}</code>
                  </td>
                  <td style={styles.td}>{TYPE_LABEL[f.type]}</td>
                  <td style={styles.td}>
                    <input style={styles.input} value={editing.name} onChange={edit('name')} />
                  </td>
                  <td style={styles.td}>
                    <input style={styles.input} value={editing.description} onChange={edit('description')} />
                  </td>
                  <td style={styles.td}>
                    <button style={styles.primaryBtn} disabled={busy} onClick={save}>
                      Save
                    </button>{' '}
                    <button style={styles.smallBtn} onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={f.key}>
                  <td style={styles.td}>
                    <code style={styles.key}>{f.key}</code>
                  </td>
                  <td style={styles.td}>{TYPE_LABEL[f.type]}</td>
                  <td style={styles.td}>{f.name}</td>
                  <td style={{ ...styles.tdWrap, color: '#868e96' }}>{f.description}</td>
                  <td style={styles.td}>
                    <button
                      style={styles.smallBtn}
                      onClick={() => setEditing({ key: f.key, name: f.name, description: f.description })}
                    >
                      Edit
                    </button>{' '}
                    <button style={styles.dangerBtn} disabled={busy} onClick={() => remove(f)}>
                      Delete
                    </button>
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>
      </div>

      <h3 style={styles.section}>Add a feature</h3>
      <form style={styles.form} onSubmit={add}>
        <label style={styles.field}>
          Key
          <input
            style={styles.input}
            placeholder="storage_gb"
            pattern="[a-z][a-z0-9_]*"
            title="Lowercase letters, digits and _, starting with a letter"
            value={draft.key}
            onChange={set('key')}
            required
          />
        </label>
        <label style={styles.field}>
          Type
          <select style={styles.input} value={draft.type} onChange={set('type')}>
            <option value="boolean">On / off</option>
            <option value="limit">Limit (number)</option>
          </select>
        </label>
        <label style={styles.field}>
          Name
          <input style={styles.input} placeholder="Storage (GB)" value={draft.name} onChange={set('name')} required />
        </label>
        <label style={{ ...styles.field, flex: 1, minWidth: 160 }}>
          Description
          <input style={styles.input} value={draft.description} onChange={set('description')} />
        </label>
        <button style={styles.primaryBtn} disabled={busy}>
          Add
        </button>
      </form>
      <p style={styles.muted}>The key and type can't change later, since plans store their values under that key.</p>
    </>
  );
}
