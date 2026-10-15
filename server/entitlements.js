// What a workspace is allowed to do, from the plan its features come from (billing.js
// currentPlan: its paid or trial plan version, otherwise the free plan). Enforce it here, on the
// server, for every gated action; the client only uses it to show or hide things.
//
//   router.put('/domain', requireUser, requireFeature('custom_domain'), handler)
//   await withinLimit(req, 'projects', (c) => c.query('INSERT INTO projects ...'))
//   await consume(req, 'api_calls_monthly')
import express from 'express';
import { query, tx } from './db.js';
import { currentPlan } from './billing.js';
import { listPublicPlans } from './catalog.js';
import { requireUser } from './auth.js';
import { HttpError } from './util.js';

// How much of each limit a workspace uses: key → { count(db, tenantId) => number, metered },
// where db is a pg client or { query }. Registered by the code that owns the data (workspace.js):
//   registerUsage(key, count)  things that exist, like projects; checked with withinLimit
//   registerMeter(key)         usage that builds up over a month, like API calls; recorded with consume
const counters = new Map();
export function registerUsage(key, count) {
  counters.set(key, { count, metered: false });
}
export function registerMeter(key) {
  counters.set(key, {
    metered: true,
    count: async (db, tenantId) => {
      const { rows } = await db.query(
        `SELECT used FROM usage_counters WHERE tenant_id = $1 AND feature_key = $2 AND period = ${PERIOD}`,
        [tenantId, key]
      );
      return Number(rows[0]?.used ?? 0);
    },
  });
}

/** Everything counted for a workspace right now: key → used (this month, for metered limits). */
export async function currentUsage(tenantId) {
  const usage = {};
  for (const [key, counter] of counters) usage[key] = await counter.count({ query }, tenantId);
  return usage;
}

// Metered limits count per calendar month in India time, not per billing period: a yearly plan's
// "API calls / month" still resets every month, and changing plans mid-month changes the limit
// but keeps what was already used (so cancelling and resubscribing doesn't reset it either).
const TIME_ZONE = 'Asia/Kolkata';
const PERIOD = `date_trunc('month', now() AT TIME ZONE '${TIME_ZONE}')::date`;
const RESETS_AT = `(date_trunc('month', now() AT TIME ZONE '${TIME_ZONE}') + interval '1 month') AT TIME ZONE '${TIME_ZONE}'`;
const day = (d) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: TIME_ZONE });

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
  const counter = counters.get(key);
  if (!counter || counter.metered) throw new Error(`"${key}" needs registerUsage('${key}', count) to be used with withinLimit`);
  const ent = await entitlementsFor(req);
  const limit = ent.limit(key);

  return tx(async (c) => {
    if (limit !== -1) {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1), $2)', [key, ent.tenantId]);
      const used = await counter.count(c, ent.tenantId);
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

/**
 * Records `amount` of a metered limit (e.g. one API call) if it still fits in this month's limit.
 * Checking and recording is one atomic statement, so concurrent requests can't go over the limit.
 * Returns { limit, used, resetsAt }; throws a 429 (recording nothing) when it doesn't fit.
 */
export async function consume(req, key, amount = 1) {
  if (!counters.get(key)?.metered) throw new Error(`"${key}" isn't metered: call registerMeter('${key}') first`);
  const ent = await entitlementsFor(req);
  const limit = ent.limit(key);

  const { rows } = await query(
    `INSERT INTO usage_counters AS u (tenant_id, feature_key, period, used)
     SELECT $1, $2, ${PERIOD}, $3::bigint WHERE $4::bigint = -1 OR $3::bigint <= $4::bigint
     ON CONFLICT (tenant_id, feature_key, period) DO UPDATE SET used = u.used + EXCLUDED.used
       WHERE $4::bigint = -1 OR u.used + EXCLUDED.used <= $4::bigint
     RETURNING used, ${RESETS_AT} AS resets_at`,
    [ent.tenantId, key, amount, limit]
  );
  if (rows[0]) return { limit, used: Number(rows[0].used), resetsAt: rows[0].resets_at };

  const used = await counters.get(key).count({ query }, ent.tenantId);
  const resetsAt = await nextReset();
  const upgradeTo = await upgradeFor(ent, key, (value) => value === -1 || value >= used + amount);
  const n = (x) => x.toLocaleString('en-IN');
  throw new HttpError(
    429,
    `${ent.name(key)} limit reached: ${n(used)} of ${n(limit)} used on the ${planName(ent)} plan. It resets on ${day(resetsAt)}, or upgrade for more now.`,
    { code: 'quota_exceeded', feature: key, limit, used, resetsAt, upgradeTo }
  );
}

/** When metered usage next starts again from zero. */
async function nextReset() {
  const { rows } = await query(`SELECT ${RESETS_AT} AS resets_at`);
  return rows[0].resets_at;
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
    let resetsAt;
    for (const f of ent.plan?.features ?? []) {
      if (f.type === 'boolean') {
        features[f.key] = f.value;
        continue;
      }
      // used is null for a limit nothing counts; resetsAt is set for metered (monthly) ones.
      const counter = counters.get(f.key);
      limits[f.key] = { name: f.name, limit: f.value, used: counter ? await counter.count({ query }, ent.tenantId) : null };
      if (counter?.metered) limits[f.key].resetsAt = resetsAt ??= await nextReset();
    }
    const plan = ent.plan && { key: ent.plan.key, name: ent.plan.name, version: ent.plan.version, paid: ent.plan.paid };
    res.json({ plan, features, limits });
  });

  return router;
}
