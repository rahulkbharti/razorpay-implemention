// The product itself: what customers pay for. A small demo, to show plan limits and features
// being enforced (see entitlements.js):
//   projects           limit    — creating one is blocked at the plan's limit
//   custom_domain      feature  — setting one needs it; removing one never does
//   api_calls_monthly  metered  — every call to the public API (/api/v1) counts; resets monthly
import express from 'express';
import { query } from './db.js';
import { requireRole, requireUser } from './auth.js';
import { requireApiKey } from './apikeys.js';
import { consume, entitlementsFor, registerMeter, registerUsage, requireFeature, withinLimit } from './entitlements.js';
import { HttpError, toId } from './util.js';

const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const countOf = async (db, sql, tenantId) => Number((await db.query(sql, [tenantId])).rows[0].count);
registerUsage('projects', (db, tenantId) => countOf(db, 'SELECT count(*) FROM projects WHERE tenant_id = $1', tenantId));
// Counted now; enforced once members can be invited (withinLimit(req, 'team_members', ...) there).
registerUsage('team_members', (db, tenantId) =>
  countOf(db, 'SELECT count(*) FROM memberships WHERE tenant_id = $1', tenantId)
);

registerMeter('api_calls_monthly');

const toProject = (r) => ({ id: r.id, name: r.name, createdAt: r.created_at });

async function listProjects(tenantId) {
  const { rows } = await query('SELECT * FROM projects WHERE tenant_id = $1 ORDER BY created_at, id', [tenantId]);
  return rows.map(toProject);
}

async function createProject(req) {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 100) throw new HttpError(400, 'Give the project a name of up to 100 characters');
  const { rows } = await withinLimit(req, 'projects', (c) =>
    c.query('INSERT INTO projects (tenant_id, name) VALUES ($1, $2) RETURNING *', [req.tenant.id, name])
  );
  return toProject(rows[0]);
}

// Counts the call against this month's API calls, and tells the caller where it stands in the
// usual rate-limit headers (also on a 429, with Retry-After until the monthly reset).
async function meterApiCall(req, res, next) {
  const setHeaders = ({ limit, used, resetsAt }) => {
    res.set({
      'X-RateLimit-Limit': String(limit),
      'X-RateLimit-Remaining': String(limit === -1 ? -1 : Math.max(0, limit - used)),
      'X-RateLimit-Reset': String(Math.floor(new Date(resetsAt).getTime() / 1000)),
    });
  };
  try {
    setHeaders(await consume(req, 'api_calls_monthly'));
  } catch (err) {
    if (err.details?.code === 'quota_exceeded') {
      setHeaders(err.details);
      res.set('Retry-After', String(Math.max(1, Math.ceil((new Date(err.details.resetsAt) - Date.now()) / 1000))));
    }
    throw err;
  }
  next();
}

/**
 * The public API, for a workspace's own code: authenticated with an API key (see apikeys.js),
 * every call metered. Plan limits apply exactly as in the app.
 */
export function publicApiRouter() {
  const router = express.Router();
  router.use(requireApiKey, meterApiCall);

  router.get('/projects', async (req, res) => {
    res.json({ data: await listProjects(req.tenant.id) });
  });

  router.post('/projects', async (req, res) => {
    res.status(201).json(await createProject(req));
  });

  return router;
}

export function workspaceRouter() {
  const router = express.Router();

  router.get('/workspace', requireUser, async (req, res) => {
    const [ent, { rows: t }, projects] = await Promise.all([
      entitlementsFor(req),
      query('SELECT custom_domain FROM tenants WHERE id = $1', [req.tenant.id]),
      listProjects(req.tenant.id),
    ]);
    const customDomain = t[0].custom_domain;
    res.json({
      customDomain,
      // A saved domain only works while the plan includes the feature.
      customDomainActive: Boolean(customDomain) && ent.can('custom_domain'),
      projects,
    });
  });

  router.post('/projects', requireUser, async (req, res) => {
    res.status(201).json(await createProject(req));
  });

  router.delete('/projects/:id', requireUser, async (req, res) => {
    const { rowCount } = await query('DELETE FROM projects WHERE id = $1 AND tenant_id = $2', [
      toId(req.params.id),
      req.tenant.id,
    ]);
    if (!rowCount) throw new HttpError(404, 'Project not found');
    res.json({ deleted: true });
  });

  router.put(
    '/workspace/domain',
    requireUser,
    requireRole('owner', 'admin'),
    requireFeature('custom_domain'),
    async (req, res) => {
      const domain = String(req.body?.domain ?? '').trim().toLowerCase().replace(/\.$/, '');
      if (!DOMAIN.test(domain)) throw new HttpError(400, 'Enter just the domain, like app.yourcompany.com');
      try {
        await query('UPDATE tenants SET custom_domain = $2 WHERE id = $1', [req.tenant.id, domain]);
      } catch (err) {
        if (err.code === '23505') throw new HttpError(409, 'Another workspace already uses that domain');
        throw err;
      }
      res.json({ customDomain: domain, customDomainActive: true });
    }
  );

  // No feature check: after a downgrade, removing the domain must still work.
  router.delete('/workspace/domain', requireUser, requireRole('owner', 'admin'), async (req, res) => {
    await query('UPDATE tenants SET custom_domain = NULL WHERE id = $1', [req.tenant.id]);
    res.json({ customDomain: null, customDomainActive: false });
  });

  return router;
}
