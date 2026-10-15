// API keys: how a workspace's own code calls the API (/api/v1) without a browser session.
// A key is shown once when it's created; only its SHA-256 hash is stored. (A fast hash is fine
// here, unlike passwords: the key is 32 random bytes, so there's nothing to guess.)
import crypto from 'node:crypto';
import express from 'express';
import { query } from './db.js';
import { productId } from './catalog.js';
import { requireRole, requireUser } from './auth.js';
import { HttpError, toId } from './util.js';

const MAX_ACTIVE_KEYS = 10;
const KEY = /^sk_[A-Za-z0-9_-]{43}$/;

const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

const toKey = (r) => ({
  id: r.id,
  name: r.name,
  hint: `sk_…${r.last_four}`,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

/**
 * Middleware for /api/v1: `Authorization: Bearer sk_...` identifies the workspace. Sets
 * req.tenant (with role 'api', so owner/admin-only actions stay off-limits to keys) and req.apiKey.
 */
export async function requireApiKey(req, _res, next) {
  const key = req.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!key) throw new HttpError(401, 'Send your API key in the header: Authorization: Bearer sk_...');
  const { rows } = KEY.test(key)
    ? await query(
        `SELECT k.id, k.tenant_id, k.last_used_at, t.name FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
         WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND t.product_id = $2`,
        [hashKey(key), productId]
      )
    : { rows: [] };
  const k = rows[0];
  if (!k) throw new HttpError(401, 'Invalid or revoked API key');

  req.user = null;
  req.tenant = { id: k.tenant_id, name: k.name, role: 'api' };
  req.apiKey = { id: k.id };
  // At most once a minute, so a busy key doesn't write on every request.
  if (!k.last_used_at || Date.now() - k.last_used_at.getTime() > 60_000) {
    await query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [k.id]);
  }
  next();
}

/** Managing a workspace's keys, from the app (logged in). */
export function apiKeysRouter() {
  const router = express.Router();

  router.get('/api-keys', requireUser, async (req, res) => {
    const { rows } = await query(
      'SELECT * FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL ORDER BY created_at',
      [req.tenant.id]
    );
    res.json(rows.map(toKey));
  });

  // The only response that ever contains the key itself.
  router.post('/api-keys', requireUser, requireRole('owner', 'admin'), async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 60) throw new HttpError(400, 'Give the key a name of up to 60 characters, like “Production server”');
    const { rows: active } = await query('SELECT count(*) FROM api_keys WHERE tenant_id = $1 AND revoked_at IS NULL', [
      req.tenant.id,
    ]);
    if (Number(active[0].count) >= MAX_ACTIVE_KEYS) {
      throw new HttpError(409, `A workspace can have ${MAX_ACTIVE_KEYS} keys at a time — revoke one you no longer use`);
    }

    const key = `sk_${crypto.randomBytes(32).toString('base64url')}`;
    const { rows } = await query(
      `INSERT INTO api_keys (tenant_id, name, key_hash, last_four, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.tenant.id, name, hashKey(key), key.slice(-4), req.user.id]
    );
    res.status(201).json({ ...toKey(rows[0]), key });
  });

  // Takes effect on the next request made with the key.
  router.delete('/api-keys/:id', requireUser, requireRole('owner', 'admin'), async (req, res) => {
    const { rowCount } = await query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL',
      [toId(req.params.id), req.tenant.id]
    );
    if (!rowCount) throw new HttpError(404, 'API key not found');
    res.json({ revoked: true });
  });

  return router;
}
