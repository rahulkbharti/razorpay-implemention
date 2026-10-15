// What a workspace is allowed to do, from the plan its features come from (billing.js
// currentPlan: its paid or trial plan version, otherwise the free plan). Enforce it here, on the
// server, for every gated action; the client only uses it to show or hide things.
//
//   router.put('/domain', requireUser, requireFeature('custom_domain'), handler)
//   await withinLimit(req, 'projects', (c) => c.query('INSERT INTO projects ...'))
import express from 'express';
import { query, tx } from './db.js';
import { currentPlan } from './billing.js';
import { listPublicPlans } from './catalog.js';
import { requireUser } from './auth.js';
import { HttpError } from './util.js';

// How much of each limit a workspace uses: key → (db, tenantId) => number, where db is a pg
// client or { query }. Registered by the code that owns the data (see workspace.js).
const counters = new Map();
export function registerUsage(key, count) {
  counters.set(key, count);
}

const warned = new Set();

/** A workspace's entitlements. Anything the plan doesn't grant is denied, unknown keys included. */
export async function getEntitlements(tenantId) {
  const plan = await currentPlan(tenantId);
  const byKey = new Map((plan?.features ?? []).map((f) => [f.key, f]));

  // A typo in a key would deny the feature forever without a word, so say so once in the log.
  const feature = (key, type) => {
    const f = byKey.get(key);
    if (f?.type === type) return f;
    if (plan && !warned.has(key)) {
      warned.add(key);
      console.warn(`[entitlements] "${key}" isn't a ${type} feature in the catalog — check the key in your code, or add it in Admin → Features`);
    }
    return null;
  };

  return {
    tenantId,
    plan,
    /** Whether an on/off feature is on. */
    can: (key) => feature(key, 'boolean')?.value === true,
    /** A limit: a whole number, -1 for unlimited, 0 when the plan doesn't include it. */
    limit: (key) => feature(key, 'limit')?.value ?? 0,
    name: (key) => byKey.get(key)?.name ?? key,
  };
}

/** The logged-in workspace's entitlements, read once per request. */
export function entitlementsFor(req) {
  if (!req.tenant) throw new HttpError(401, 'Please log in');
  req.entitlements ??= getEntitlements(req.tenant.id);
  return req.entitlements;
}

/** Middleware: only continue if the workspace's plan has this on/off feature. */
export const requireFeature = (key) => async (req, _res, next) => {
  const ent = await entitlementsFor(req);
  if (!ent.can(key)) {
    const upgradeTo = await upgradeFor(ent, key, (value) => value === true);
    throw new HttpError(403, `${ent.name(key)} isn't included in your ${planName(ent)} plan.`, {
      code: 'feature_not_in_plan',
      feature: key,
      upgradeTo,
    });
  }
  next();
};

/**
 * Runs create(client) in a transaction if the workspace is under its limit for `key`.
 * A per-workspace lock makes concurrent requests count and create one after the other, so two
 * at once can't both slip under the limit. Being over the limit (e.g. after a downgrade) only
 * blocks adding more: nothing that already exists is touched.
 */
export async function withinLimit(req, key, create) {
  const count = counters.get(key);
  if (!count) throw new Error(`No usage counter registered for "${key}"`);
  const ent = await entitlementsFor(req);
  const limit = ent.limit(key);

  return tx(async (c) => {
    if (limit !== -1) {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1), $2)', [key, ent.tenantId]);
      const used = await count(c, ent.tenantId);
      if (used >= limit) {
        const upgradeTo = await upgradeFor(ent, key, (value) => value === -1 || value > used);
        const name = ent.name(key).toLowerCase();
        throw new HttpError(403, `You're using ${used} of ${limit} ${name} on the ${planName(ent)} plan. Upgrade to add more.`, {
          code: 'limit_reached',
          feature: key,
          limit,
          used,
          upgradeTo,
        });
      }
    }
    return create(c);
  });
}

const planName = (ent) => ent.plan?.name ?? 'current';

// The first paid public plan, in pricing-page order, that would allow it: what to suggest upgrading to.
async function upgradeFor(ent, key, allows) {
  const plans = await listPublicPlans();
  const plan = plans.find(
    (p) => p.key !== ent.plan?.key && p.prices.length > 0 && allows(p.features.find((f) => f.key === key)?.value)
  );
  return plan ? { key: plan.key, name: plan.name } : null;
}

/** GET /api/me/entitlements: what the client needs to show or hide features and usage meters. */
export function entitlementsRouter() {
  const router = express.Router();

  router.get('/me/entitlements', requireUser, async (req, res) => {
    const ent = await entitlementsFor(req);
    const features = {};
    const limits = {};
    for (const f of ent.plan?.features ?? []) {
      if (f.type === 'boolean') {
        features[f.key] = f.value;
      } else {
        const count = counters.get(f.key);
        // used is null for a limit nothing counts yet (e.g. API calls, until usage is metered).
        limits[f.key] = { name: f.name, limit: f.value, used: count ? await count({ query }, ent.tenantId) : null };
      }
    }
    const plan = ent.plan && { key: ent.plan.key, name: ent.plan.name, version: ent.plan.version, paid: ent.plan.paid };
    res.json({ plan, features, limits });
  });

  return router;
}
