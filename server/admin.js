// Admin API for the feature catalog and plans. Guarded by ADMIN_TOKEN until there are
// real user accounts with an admin role.
import express from 'express';
import * as catalog from './catalog.js';
import { currentPlan, listTenants } from './billing.js';
import { query } from './db.js';
import { runBillingJob } from './manual.js';
import { HttpError, safeEqual, toId } from './util.js';

const KEY = /^[a-z][a-z0-9_]{0,62}$/;
const TYPES = ['boolean', 'limit'];
const PERIODS = ['monthly', 'yearly'];

export function adminRouter(adminToken) {
  const router = express.Router();

  router.use((req, _res, next) => {
    if (!adminToken) throw new HttpError(503, 'Set ADMIN_TOKEN in server/.env to use the admin panel');
    const token = req.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (!token || !safeEqual(adminToken, token)) throw new HttpError(401, 'Wrong admin token');
    next();
  });

  /* ---------- Features ---------- */

  router.get('/features', async (_req, res) => {
    res.json(await catalog.listFeatures());
  });

  router.post('/features', async (req, res) => {
    const b = req.body ?? {};
    if (!TYPES.includes(b.type)) throw new HttpError(400, 'type must be "boolean" or "limit"');
    const feature = await catalog.createFeature({
      key: key(b.key),
      type: b.type,
      name: text(b.name, 'name', { required: true }),
      description: text(b.description, 'description', { blank: true, max: 500 }) ?? '',
      sortOrder: int(b.sortOrder, 'sortOrder'),
    });
    res.status(201).json(feature);
  });

  router.patch('/features/:key', async (req, res) => {
    const b = req.body ?? {};
    res.json(
      await catalog.updateFeature(req.params.key, {
        name: text(b.name, 'name'),
        description: text(b.description, 'description', { blank: true, max: 500 }),
        sortOrder: int(b.sortOrder, 'sortOrder'),
      })
    );
  });

  router.delete('/features/:key', async (req, res) => {
    await catalog.deleteFeature(req.params.key);
    res.json({ deleted: true });
  });

  /* ---------- Plans ---------- */

  router.get('/plans', async (_req, res) => {
    res.json(await catalog.listPlans());
  });

  router.post('/plans', async (req, res) => {
    const b = req.body ?? {};
    const plan = await catalog.createPlan({
      key: key(b.key),
      name: text(b.name, 'name', { required: true }),
      description: text(b.description, 'description', { blank: true, max: 500 }),
      isPublic: bool(b.isPublic, 'isPublic'),
      sortOrder: int(b.sortOrder, 'sortOrder'),
      trialDays: trialDays(b.trialDays),
      entitlements: b.entitlements,
    });
    res.status(201).json(plan);
  });

  router.patch('/plans/:id', async (req, res) => {
    const b = req.body ?? {};
    res.json(
      await catalog.updatePlan(id(req), {
        name: text(b.name, 'name'),
        description: text(b.description, 'description', { blank: true, max: 500 }),
        isPublic: bool(b.isPublic, 'isPublic'),
        sortOrder: int(b.sortOrder, 'sortOrder'),
        trialDays: trialDays(b.trialDays),
        entitlements: b.entitlements,
      })
    );
  });

  router.delete('/plans/:id', async (req, res) => {
    await catalog.deletePlan(id(req));
    res.json({ deleted: true });
  });

  router.post('/plans/:id/publish', async (req, res) => {
    res.json(await catalog.publishPlan(id(req)));
  });

  router.post('/plans/:id/archive', async (req, res) => {
    res.json(await catalog.archivePlan(id(req)));
  });

  router.post('/plans/:id/versions', async (req, res) => {
    res.status(201).json(await catalog.newPlanVersion(id(req)));
  });

  /* ---------- Prices ---------- */

  router.post('/plans/:id/prices', async (req, res) => {
    const { period, amount } = req.body ?? {};
    if (!PERIODS.includes(period)) throw new HttpError(400, 'period must be "monthly" or "yearly"');
    if (!Number.isInteger(amount) || amount < 100 || amount > 2147483647) {
      throw new HttpError(400, 'amount must be in paise, at least 100 (₹1)');
    }
    res.json(await catalog.setPrice(id(req), { period, amount }));
  });

  router.delete('/prices/:id', async (req, res) => {
    res.json(await catalog.removePrice(id(req)));
  });

  /* ---------- Tenants ---------- */

  router.get('/tenants', async (_req, res) => {
    res.json(await listTenants());
  });

  // One workspace's overrides: every catalog feature with the plan's value and the override, if any.
  router.get('/tenants/:id/overrides', async (req, res) => {
    const t = await tenant(req);
    const plan = await currentPlan(t.id);
    res.json({
      tenant: { id: t.id, name: t.name },
      plan: plan && { key: plan.key, name: plan.name, version: plan.version },
      note: t.overrides_note,
      features: (plan?.features ?? []).map((f) => ({
        key: f.key,
        name: f.name,
        type: f.type,
        planValue: f.overridden ? f.planValue : f.value,
        override: f.overridden ? f.value : null,
      })),
    });
  });

  // Replaces the workspace's overrides. Every value given replaces the plan's (false and 0 too);
  // leave a key out to follow the plan. They apply whatever plan the workspace is on, until removed.
  router.put('/tenants/:id/overrides', async (req, res) => {
    const t = await tenant(req);
    const overrides = catalog.normalizeEntitlements(req.body?.overrides ?? {}, await catalog.listFeatures(), {
      explicit: true,
    });
    const note = text(req.body?.note, 'note', { blank: true, max: 500 }) ?? '';
    await query('UPDATE tenants SET overrides = $2, overrides_note = $3 WHERE id = $1', [t.id, JSON.stringify(overrides), note]);
    res.json({ overrides, note });
  });

  // Runs the hourly billing job now (renewal invoices, reminders, grace period, expiry).
  router.post('/jobs/billing', async (_req, res) => {
    res.json(await runBillingJob());
  });

  return router;
}

/* ---------- Input checks (undefined = "not sent", so PATCH leaves the field alone) ---------- */

function key(value) {
  if (typeof value !== 'string' || !KEY.test(value)) {
    throw new HttpError(400, 'key must be lowercase letters, digits and _, starting with a letter');
  }
  return value;
}

function text(value, field, { required = false, blank = false, max = 100 } = {}) {
  if (value === undefined) {
    if (required) throw new HttpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || value.length > max) {
    throw new HttpError(400, `${field} must be text of up to ${max} characters`);
  }
  if (!blank && !value.trim()) throw new HttpError(400, `${field} can't be empty`);
  return value.trim();
}

function int(value, field) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Math.abs(value) > 1_000_000) throw new HttpError(400, `${field} must be a whole number`);
  return value;
}

function trialDays(value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 365) throw new HttpError(400, 'trialDays must be 0–365');
  return value;
}

function bool(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be true or false`);
  return value;
}

async function tenant(req) {
  const { rows } = await query('SELECT * FROM tenants WHERE id = $1 AND product_id = $2', [id(req), catalog.productId]);
  if (!rows[0]) throw new HttpError(404, 'Workspace not found');
  return rows[0];
}

function id(req) {
  const value = toId(req.params.id);
  if (!value) throw new HttpError(404, 'Not found');
  return value;
}
