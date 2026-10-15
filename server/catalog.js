// Feature catalog, plans and prices. See migrations/001_catalog.sql for the rules.
import { query, tx } from './db.js';
import { HttpError } from './util.js';

// One product for now. Serving several SaaS products later means passing this in per request.
export let productId;
export async function initCatalog() {
  const { rows } = await query("SELECT id FROM products WHERE key = 'default'");
  productId = rows[0].id;
}

const SECTION = { boolean: 'features', limit: 'limits' };
const label = (plan) => `${plan.key} v${plan.version}`;

/* ---------- Entitlements ---------- */

// Checks a plan's entitlements against the catalog and drops anything off or 0: a missing
// key already means that, so the stored JSON lists only what the plan actually grants.
// With { explicit: true } (a workspace's overrides) false and 0 are kept: there they mean
// "turn this off for this workspace", which is different from "same as the plan".
export function normalizeEntitlements(input, features, { explicit = false } = {}) {
  if (!isObject(input)) throw new HttpError(400, 'entitlements must be an object');
  const extra = Object.keys(input).find((k) => k !== 'features' && k !== 'limits');
  if (extra) throw new HttpError(400, `Unknown section "${extra}" — use "features" and "limits"`);

  const byKey = new Map(features.map((f) => [f.key, f]));
  const out = { features: {}, limits: {} };

  for (const section of ['features', 'limits']) {
    const values = input[section] ?? {};
    if (!isObject(values)) throw new HttpError(400, `"${section}" must be an object`);

    for (const [key, value] of Object.entries(values)) {
      const feature = byKey.get(key);
      if (!feature) throw new HttpError(400, `Unknown feature "${key}" — add it to the catalog first`);
      if (SECTION[feature.type] !== section) {
        throw new HttpError(400, `"${key}" is a ${feature.type}, so it goes under "${SECTION[feature.type]}"`);
      }
      if (section === 'features') {
        if (typeof value !== 'boolean') throw new HttpError(400, `"${key}" must be true or false`);
        if (value || explicit) out.features[key] = value;
      } else {
        if (!Number.isSafeInteger(value) || value < -1) {
          throw new HttpError(400, `"${key}" must be a whole number (-1 = unlimited)`);
        }
        if (value !== 0 || explicit) out.limits[key] = value;
      }
    }
  }
  return out;
}

/**
 * Every catalog feature with this plan's value for it (false / 0 when the plan doesn't grant it).
 * A workspace's overrides replace the plan's value; those come back with overridden and planValue.
 */
export function resolveEntitlements(entitlements, features, overrides) {
  return features.map((f) => {
    const planValue =
      f.type === 'boolean' ? entitlements.features?.[f.key] === true : (entitlements.limits?.[f.key] ?? 0);
    const override = overrides?.[SECTION[f.type]]?.[f.key];
    return {
      key: f.key,
      name: f.name,
      type: f.type,
      value: override ?? planValue,
      ...(override !== undefined && { overridden: true, planValue }),
    };
  });
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/* ---------- Features ---------- */

const toFeature = (r) => ({
  key: r.key,
  type: r.type,
  name: r.name,
  description: r.description,
  sortOrder: r.sort_order,
});

export async function listFeatures() {
  const { rows } = await query('SELECT * FROM features WHERE product_id = $1 ORDER BY sort_order, id', [productId]);
  return rows.map(toFeature);
}

export async function createFeature({ key, type, name, description, sortOrder }) {
  const { rows } = await query(
    `INSERT INTO features (product_id, key, type, name, description, sort_order)
     VALUES ($1, $2, $3, $4, $5,
             COALESCE($6, (SELECT COALESCE(max(sort_order), 0) + 1 FROM features WHERE product_id = $1)))
     RETURNING *`,
    [productId, key, type, name, description, sortOrder ?? null]
  );
  return toFeature(rows[0]);
}

// The key and type can't change: plans already store values under that key, of that type.
export async function updateFeature(key, { name, description, sortOrder }) {
  const { rows } = await query(
    `UPDATE features
     SET name = COALESCE($3, name), description = COALESCE($4, description), sort_order = COALESCE($5, sort_order)
     WHERE product_id = $1 AND key = $2
     RETURNING *`,
    [productId, key, name ?? null, description ?? null, sortOrder ?? null]
  );
  if (!rows[0]) throw new HttpError(404, 'Feature not found');
  return toFeature(rows[0]);
}

export async function deleteFeature(key) {
  // Archived versions count too: customers on them still rely on the feature.
  const { rows: grantedBy } = await query(
    `SELECT key, version, status FROM plans
     WHERE product_id = $1 AND (entitlements->'features' ? $2 OR entitlements->'limits' ? $2)
     ORDER BY key, version`,
    [productId, key]
  );
  if (grantedBy.length) {
    const list = grantedBy.map((p) => `${label(p)} (${p.status})`).join(', ');
    throw new HttpError(409, `"${key}" is still granted by ${list}`);
  }
  const { rows: overriddenBy } = await query(
    `SELECT name FROM tenants WHERE product_id = $1 AND (overrides->'features' ? $2 OR overrides->'limits' ? $2) ORDER BY name LIMIT 5`,
    [productId, key]
  );
  if (overriddenBy.length) {
    throw new HttpError(409, `"${key}" is still overridden for ${overriddenBy.map((t) => t.name).join(', ')} — clear those first`);
  }
  const { rowCount } = await query('DELETE FROM features WHERE product_id = $1 AND key = $2', [productId, key]);
  if (!rowCount) throw new HttpError(404, 'Feature not found');
}

/* ---------- Plans ---------- */

const PLANS_WITH_PRICES = `
  SELECT p.*,
         COALESCE(json_agg(pp ORDER BY pp.is_active DESC, pp.period, pp.id) FILTER (WHERE pp.id IS NOT NULL), '[]') AS prices
  FROM plans p
  LEFT JOIN plan_prices pp ON pp.plan_id = p.id`;

const toPrice = (r) => ({
  id: r.id,
  period: r.period,
  amount: r.amount,
  currency: r.currency,
  isActive: r.is_active,
  razorpayPlanId: r.razorpay_plan_id,
});

const toPlan = (r) => ({
  id: r.id,
  key: r.key,
  version: r.version,
  status: r.status,
  name: r.name,
  description: r.description,
  entitlements: r.entitlements,
  isPublic: r.is_public,
  sortOrder: r.sort_order,
  trialDays: r.trial_days,
  publishedAt: r.published_at,
  prices: r.prices.map(toPrice),
});

/** All plans and all their versions, for the admin panel. */
export async function listPlans() {
  const { rows } = await query(
    `${PLANS_WITH_PRICES} WHERE p.product_id = $1 GROUP BY p.id ORDER BY p.sort_order, p.key, p.version DESC`,
    [productId]
  );
  return rows.map(toPlan);
}

export async function getPlan(id) {
  const { rows } = await query(`${PLANS_WITH_PRICES} WHERE p.id = $1 AND p.product_id = $2 GROUP BY p.id`, [
    id,
    productId,
  ]);
  if (!rows[0]) throw new HttpError(404, 'Plan not found');
  return toPlan(rows[0]);
}

/** What the pricing page shows: the live version of each public plan, with every feature resolved. */
export async function listPublicPlans() {
  const [features, { rows }] = await Promise.all([
    listFeatures(),
    query(
      `SELECT p.*, COALESCE(json_agg(pp ORDER BY pp.period) FILTER (WHERE pp.id IS NOT NULL), '[]') AS prices
       FROM plans p
       LEFT JOIN plan_prices pp ON pp.plan_id = p.id AND pp.is_active
       WHERE p.product_id = $1 AND p.status = 'active' AND p.is_public
       GROUP BY p.id
       ORDER BY p.sort_order, p.id`,
      [productId]
    ),
  ]);
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    trialDays: r.trial_days,
    prices: r.prices.map(({ id, period, amount, currency }) => ({ id, period, amount, currency })),
    features: resolveEntitlements(r.entitlements, features),
  }));
}

/** Creates version 1 of a new plan, as a draft. */
export async function createPlan({ key, name, description, isPublic, sortOrder, trialDays, entitlements = {} }) {
  const normalized = normalizeEntitlements(entitlements, await listFeatures());
  const { rows } = await query(
    `INSERT INTO plans (product_id, key, version, name, description, is_public, sort_order, trial_days, entitlements)
     VALUES ($1, $2, 1, $3, $4, $5,
             COALESCE($6, (SELECT COALESCE(max(sort_order), 0) + 1 FROM plans WHERE product_id = $1)), $7, $8)
     RETURNING id`,
    [productId, key, name, description ?? '', isPublic ?? true, sortOrder ?? null, trialDays ?? 0, JSON.stringify(normalized)]
  );
  return getPlan(rows[0].id);
}

// Name, description, visibility and trial length can change on any version (they only affect
// people who subscribe later). Entitlements only on a draft: a published version is what its
// customers paid for.
export async function updatePlan(id, { name, description, isPublic, sortOrder, trialDays, entitlements }) {
  const features = entitlements === undefined ? null : await listFeatures();
  await tx(async (c) => {
    const plan = await lockPlan(c, id);
    let normalized = null;
    if (features) {
      if (plan.status !== 'draft') {
        throw new HttpError(409, `${label(plan)} is ${plan.status}, so its features are locked — create a new version`);
      }
      normalized = JSON.stringify(normalizeEntitlements(entitlements, features));
    }
    await c.query(
      `UPDATE plans
       SET name = COALESCE($2, name), description = COALESCE($3, description), is_public = COALESCE($4, is_public),
           sort_order = COALESCE($5, sort_order), entitlements = COALESCE($6::jsonb, entitlements),
           trial_days = COALESCE($7, trial_days)
       WHERE id = $1`,
      [id, name ?? null, description ?? null, isPublic ?? null, sortOrder ?? null, normalized, trialDays ?? null]
    );
  });
  return getPlan(id);
}

export async function deletePlan(id) {
  await tx(async (c) => {
    const plan = await lockPlan(c, id);
    if (plan.status !== 'draft') {
      throw new HttpError(409, `Only drafts can be deleted — archive ${label(plan)} to stop selling it`);
    }
    await c.query('DELETE FROM plans WHERE id = $1', [id]);
  });
}

/** Makes a draft the live version. The previous live version is archived, not changed. */
export async function publishPlan(id) {
  await tx(async (c) => {
    const plan = await lockPlan(c, id);
    if (plan.status !== 'draft') throw new HttpError(409, `${label(plan)} is already ${plan.status}`);
    await c.query(`UPDATE plans SET status = 'archived' WHERE product_id = $1 AND key = $2 AND status = 'active'`, [
      productId,
      plan.key,
    ]);
    await c.query(`UPDATE plans SET status = 'active', published_at = now() WHERE id = $1`, [id]);
  });
  return getPlan(id);
}

/** Stops selling a plan. Customers already on it keep it. */
export async function archivePlan(id) {
  await tx(async (c) => {
    const plan = await lockPlan(c, id);
    if (plan.status !== 'active') throw new HttpError(409, `${label(plan)} is ${plan.status}, not active`);
    await c.query(`UPDATE plans SET status = 'archived' WHERE id = $1`, [id]);
  });
  return getPlan(id);
}

/** Copies a version (its entitlements and current prices) into a new draft. */
export async function newPlanVersion(id) {
  const newId = await tx(async (c) => {
    const source = await lockPlan(c, id);
    const { rows: drafts } = await c.query(
      `SELECT version FROM plans WHERE product_id = $1 AND key = $2 AND status = 'draft'`,
      [productId, source.key]
    );
    if (drafts[0]) throw new HttpError(409, `${source.key} v${drafts[0].version} is already a draft — edit that one`);

    const { rows } = await c.query(
      `INSERT INTO plans (product_id, key, version, name, description, entitlements, is_public, sort_order, trial_days)
       SELECT product_id, key, (SELECT max(version) + 1 FROM plans WHERE product_id = $2 AND key = $3),
              name, description, entitlements, is_public, sort_order, trial_days
       FROM plans WHERE id = $1
       RETURNING id`,
      [id, productId, source.key]
    );
    // New price rows (no Razorpay plan yet): each version's customers get their own Razorpay plans.
    await c.query(
      `INSERT INTO plan_prices (plan_id, period, amount, currency)
       SELECT $2, period, amount, currency FROM plan_prices WHERE plan_id = $1 AND is_active`,
      [id, rows[0].id]
    );
    return rows[0].id;
  });
  return getPlan(newId);
}

async function lockPlan(client, id) {
  const { rows } = await client.query('SELECT * FROM plans WHERE id = $1 AND product_id = $2 FOR UPDATE', [
    id,
    productId,
  ]);
  if (!rows[0]) throw new HttpError(404, 'Plan not found');
  return rows[0];
}

/* ---------- Prices ---------- */

/** Sets the plan's price for a period, retiring the current one. */
export async function setPrice(planId, { period, amount }) {
  await tx(async (c) => {
    const plan = await lockPlan(c, planId);
    if (plan.status === 'archived') throw new HttpError(409, `${label(plan)} is archived — its prices can't change`);
    const { rows } = await c.query(
      'SELECT * FROM plan_prices WHERE plan_id = $1 AND period = $2 AND is_active FOR UPDATE',
      [planId, period]
    );
    if (rows[0]?.amount === amount) return;
    if (rows[0]) await retirePrice(c, rows[0]);
    await c.query('INSERT INTO plan_prices (plan_id, period, amount) VALUES ($1, $2, $3)', [planId, period, amount]);
  });
  return getPlan(planId);
}

/** Stops selling a price. */
export async function removePrice(priceId) {
  const planId = await tx(async (c) => {
    const { rows } = await c.query(
      `SELECT pp.*, p.key, p.version, p.status AS plan_status
       FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id
       WHERE pp.id = $1 AND p.product_id = $2
       FOR UPDATE OF pp`,
      [priceId, productId]
    );
    const price = rows[0];
    if (!price?.is_active) throw new HttpError(404, 'Price not found');
    if (price.plan_status === 'archived') throw new HttpError(409, `${label(price)} is archived — its prices can't change`);
    await retirePrice(c, price);
    return price.plan_id;
  });
  return getPlan(planId);
}

// A price that was never sold can just go. One that was (it has a Razorpay plan or a
// subscription) may still have customers paying it, so keep the row and only stop offering it.
async function retirePrice(client, price) {
  const { rowCount } = await client.query(
    `DELETE FROM plan_prices
     WHERE id = $1 AND razorpay_plan_id IS NULL AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE price_id = $1)`,
    [price.id]
  );
  if (!rowCount) await client.query('UPDATE plan_prices SET is_active = false WHERE id = $1', [price.id]);
}

/* ---------- Selling (used by the subscription flow) ---------- */

const PRICE_WITH_PLAN = `
  SELECT pp.*, p.key AS plan_key, p.name AS plan_name, p.version AS plan_version, p.trial_days
  FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id`;

const toSellable = (r) =>
  r
    ? {
        id: r.id,
        period: r.period,
        amount: r.amount,
        currency: r.currency,
        razorpayPlanId: r.razorpay_plan_id,
        planId: r.plan_id,
        planKey: r.plan_key,
        planName: r.plan_name,
        planVersion: r.plan_version,
        trialDays: r.trial_days,
      }
    : null;

/** A price new customers can subscribe to, or null. */
export async function findSellablePrice(id) {
  const { rows } = await query(
    `${PRICE_WITH_PLAN} WHERE pp.id = $1 AND p.product_id = $2 AND pp.is_active AND p.status = 'active'`,
    [id, productId]
  );
  return toSellable(rows[0]);
}

/** Any price of this product, retired or not (e.g. the one a customer is still paying), or null. */
export async function findPrice(id) {
  const { rows } = await query(`${PRICE_WITH_PLAN} WHERE pp.id = $1 AND p.product_id = $2`, [id, productId]);
  return toSellable(rows[0]);
}

/** Saves the Razorpay plan made for a price. If another request saved one first, returns that one. */
export async function saveRazorpayPlanId(priceId, razorpayPlanId) {
  const { rows } = await query(
    'UPDATE plan_prices SET razorpay_plan_id = COALESCE(razorpay_plan_id, $2) WHERE id = $1 RETURNING razorpay_plan_id',
    [priceId, razorpayPlanId]
  );
  return rows[0].razorpay_plan_id;
}
