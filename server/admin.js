// Admin API for the feature catalog and plans. Guarded by ADMIN_TOKEN until there are
// real user accounts with an admin role.
import express from 'express';
import * as catalog from './catalog.js';
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

function bool(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new HttpError(400, `${field} must be true or false`);
  return value;
}

function id(req) {
  const value = toId(req.params.id);
  if (!value) throw new HttpError(404, 'Not found');
  return value;
}
