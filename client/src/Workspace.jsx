import { useCallback, useEffect, useState } from 'react';
import { api, formatLimit } from './api.js';
import { styles } from './styles.js';
import ApiKeys from './ApiKeys.jsx';

// The product the customer pays for (a small demo). The server enforces every rule this page
// shows; hiding or disabling things here only spares the customer a request it would refuse.
export default function Workspace({ config, me, onUpgrade }) {
  const [ent, setEnt] = useState(null);
  const [ws, setWs] = useState(null);
  const [projectName, setProjectName] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const canAdmin = me.tenant.role !== 'member';

  const load = useCallback(async () => {
    const [e, w] = await Promise.all([api('/api/me/entitlements'), api('/api/workspace')]);
    setEnt(e);
    setWs(w);
  }, []);

  useEffect(() => {
    load().catch((e) => setResult({ ok: false, msg: e.message }));
  }, [load]);

  async function run(fn, okMsg) {
    setBusy(true);
    setResult(null);
    try {
      await fn();
      await load();
      if (okMsg) setResult({ ok: true, msg: okMsg });
      return true;
    } catch (e) {
      // A refusal for the plan says what to upgrade to (e.data.code is 'limit_reached' or 'feature_not_in_plan').
      setResult({ ok: false, msg: e.message, upgradeTo: e.data?.upgradeTo });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addProject(e) {
    e.preventDefault();
    const name = projectName.trim();
    if (await run(() => api('/api/projects', { name }), `Added “${name}”`)) setProjectName('');
  }

  function removeProject(p) {
    if (window.confirm(`Delete “${p.name}”?`)) run(() => api(`/api/projects/${p.id}`, undefined, { method: 'DELETE' }));
  }

  async function saveDomain(e) {
    e.preventDefault();
    if (await run(() => api('/api/workspace/domain', { domain }, { method: 'PUT' }), 'Domain saved')) setDomain('');
  }

  function removeDomain() {
    if (window.confirm(`Remove ${ws.customDomain}?`)) {
      run(() => api('/api/workspace/domain', undefined, { method: 'DELETE' }), 'Domain removed');
    }
  }

  if (!ent || !ws) return result ? <p style={styles.notice(false)}>{result.msg}</p> : <p>Loading…</p>;

  const plan = ent.plan?.name ?? 'current';
  const upgrade = (key, allows) => upgradeFor(config.plans, ent.plan?.key, key, allows);
  const projects = ent.limits.projects ?? { limit: 0, used: ws.projects.length };
  const projectsFull = projects.limit !== -1 && projects.used >= projects.limit;
  const domainOn = ent.features.custom_domain === true;

  return (
    <>
      <div style={styles.header}>
        <h1 style={{ margin: 0 }}>{me.tenant.name}</h1>
        <span style={styles.per}>{plan} plan</span>
      </div>

      <h3 style={styles.section}>Usage</h3>
      {Object.entries(ent.limits).map(([key, l]) => (
        <Meter key={key} {...l} />
      ))}

      <h3 style={styles.section}>Projects</h3>
      {ws.projects.length === 0 ? (
        <p style={styles.muted}>No projects yet.</p>
      ) : (
        <ul style={styles.list}>
          {ws.projects.map((p) => (
            <li key={p.id} style={styles.listRow}>
              <span>{p.name}</span>
              <button style={styles.dangerBtn} disabled={busy} onClick={() => removeProject(p)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {projectsFull ? (
        <Locked
          plan={upgrade('projects', (v) => v === -1 || v > projects.used)}
          onUpgrade={onUpgrade}
          text={
            projects.limit === 0
              ? `Projects aren't included in your ${plan} plan.`
              : projects.used > projects.limit
                ? `You have ${projects.used} projects but the ${plan} plan allows ${projects.limit}. They all stay; remove some or upgrade to add more.`
                : projects.limit === 1
                  ? `Your ${plan} plan allows 1 project, and you've used it.`
                  : `Your ${plan} plan allows ${projects.limit} projects, and you've used them all.`
          }
        />
      ) : (
        <form style={{ ...styles.form, marginTop: 12 }} onSubmit={addProject}>
          <input
            style={{ ...styles.input, flex: 1, minWidth: 180 }}
            placeholder="Project name"
            aria-label="Project name"
            maxLength={100}
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            required
          />
          <button style={styles.primaryBtn} disabled={busy}>
            Add project
          </button>
        </form>
      )}

      <h3 style={styles.section}>Custom domain</h3>
      {ws.customDomain && (
        <div style={styles.listRow}>
          <span>
            <code style={styles.key}>{ws.customDomain}</code>
            <span style={styles.badge(ws.customDomainActive ? 'active' : 'halted')}>
              {ws.customDomainActive ? 'active' : 'inactive'}
            </span>
          </span>
          {canAdmin && (
            <button style={styles.dangerBtn} disabled={busy} onClick={removeDomain}>
              Remove
            </button>
          )}
        </div>
      )}
      {!domainOn ? (
        <Locked
          plan={upgrade('custom_domain', (v) => v === true)}
          onUpgrade={onUpgrade}
          text={
            ws.customDomain
              ? `Your ${plan} plan doesn't include custom domains, so this one isn't served. It works again when you upgrade.`
              : `Custom domains aren't included in your ${plan} plan.`
          }
        />
      ) : !canAdmin ? (
        <p style={styles.muted}>Only the workspace owner or an admin can change the domain.</p>
      ) : (
        !ws.customDomain && (
          <form style={styles.form} onSubmit={saveDomain}>
            <input
              style={{ ...styles.input, flex: 1, minWidth: 180 }}
              placeholder="app.yourcompany.com"
              aria-label="Domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              required
            />
            <button style={styles.primaryBtn} disabled={busy}>
              Save domain
            </button>
          </form>
        )
      )}

      {result && (
        <div style={{ ...styles.notice(result.ok), ...styles.listRow }}>
          <span>{result.msg}</span>
          {result.upgradeTo && (
            <button style={styles.primaryBtn} onClick={onUpgrade}>
              Upgrade to {result.upgradeTo.name}
            </button>
          )}
        </div>
      )}

      <ApiKeys canAdmin={canAdmin} onUsageChange={() => load().catch((e) => setResult({ ok: false, msg: e.message }))} />
    </>
  );
}

// The first paid public plan that would allow it (the server suggests the same one when it refuses).
function upgradeFor(plans, currentKey, key, allows) {
  return plans.find(
    (p) => p.key !== currentKey && p.prices.length > 0 && allows(p.features.find((f) => f.key === key)?.value)
  );
}

function Meter({ name, limit, used, resetsAt }) {
  const unlimited = limit === -1;
  const counted = used !== null;
  // At the limit is normal (nothing more can be added); over it only happens after a downgrade.
  const level = !counted || unlimited ? 'ok' : used > limit ? 'over' : used === limit ? 'full' : 'ok';
  const percent = !counted || unlimited ? 0 : limit === 0 ? 100 : Math.min(100, (used / limit) * 100);
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={styles.meterHead}>
        <span>{name}</span>
        <span style={styles.meterText(level)}>
          {counted ? `${used.toLocaleString('en-IN')} / ${formatLimit(limit)}` : `${formatLimit(limit)} included`}
        </span>
      </div>
      {/* Monthly usage (API calls) starts again from zero on the 1st. */}
      {resetsAt && (
        <div style={{ ...styles.per, fontSize: 12, marginBottom: 4 }}>
          Resets on {new Date(resetsAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}
        </div>
      )}
      {counted && !unlimited && (
        <div style={styles.meterTrack} role="progressbar" aria-label={name} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
          <div style={styles.meterFill(percent, level)} />
        </div>
      )}
    </div>
  );
}

function Locked({ text, plan, onUpgrade }) {
  return (
    <div style={styles.locked}>
      <span>
        {text}
        {plan && ` Available on ${plan.name}.`}
      </span>
      <button style={styles.primaryBtn} onClick={onUpgrade}>
        {plan ? `Upgrade to ${plan.name}` : 'See plans'}
      </button>
    </div>
  );
}
