// Email + password accounts. Each signup creates a workspace (tenant) owned by the new user.
// The session is a random token in an httpOnly cookie; only its hash is stored.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { query, tx } from './db.js';
import { productId } from './catalog.js';
import { HttpError } from './util.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'sid';
const SESSION_DAYS = 30;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9]{10,15}$/;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function checkPassword(password, stored) {
  const [, salt, hash] = stored.split('$');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'base64'));
}

// Checked when the email doesn't exist, so a wrong email takes as long as a wrong password
// and response times don't reveal who has an account.
const DUMMY_HASH = await hashPassword('not-a-real-password');

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), userId, SESSION_DAYS]
  );
  res.cookie(COOKIE, token, {
    httpOnly: true, // page scripts can't read it
    sameSite: 'lax', // not sent on cross-site POSTs, which blocks CSRF
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function readCookie(req, name) {
  for (const part of req.get('cookie')?.split(';') ?? []) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** Sets req.user and req.tenant for a logged-in request (both null otherwise). */
export async function loadSession(req, _res, next) {
  req.user = null;
  req.tenant = null;
  const token = readCookie(req, COOKIE);
  if (token) {
    // One workspace per user for now: their first membership.
    const { rows } = await query(
      `SELECT u.id, u.email, u.name, u.phone, t.id AS tenant_id, t.name AS tenant_name, m.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN LATERAL (
         SELECT m.* FROM memberships m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = u.id AND t.product_id = $2
         ORDER BY m.created_at LIMIT 1
       ) m ON true
       JOIN tenants t ON t.id = m.tenant_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token), productId]
    );
    const r = rows[0];
    if (r) {
      req.user = { id: r.id, email: r.email, name: r.name, phone: r.phone };
      req.tenant = { id: r.tenant_id, name: r.tenant_name, role: r.role };
    }
  }
  next();
}

export function requireUser(req, _res, next) {
  if (!req.user) throw new HttpError(401, 'Please log in');
  next();
}

/** Only these roles in the workspace may continue (e.g. billing is for owners and admins). */
export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!roles.includes(req.tenant?.role)) throw new HttpError(403, 'Only the workspace owner or an admin can do that');
    next();
  };

export function authRouter() {
  const router = express.Router();

  router.post('/signup', async (req, res) => {
    const b = req.body ?? {};
    const name = field(b.name, 'Name', 100);
    const email = field(b.email, 'Email', 254).toLowerCase();
    if (!EMAIL.test(email)) throw new HttpError(400, 'Enter a valid email');
    const password = newPassword(b.password);
    const phone = b.phone ? String(b.phone).replace(/[\s-]/g, '') : null;
    if (phone && !PHONE.test(phone)) throw new HttpError(400, 'Enter a phone number with 10–15 digits');
    const workspace = b.workspace?.trim() ? field(b.workspace, 'Workspace name', 100) : `${name}'s workspace`;
    const passwordHash = await hashPassword(password);

    const userId = await tx(async (c) => {
      const { rows } = await c
        .query('INSERT INTO users (email, password_hash, name, phone) VALUES ($1, $2, $3, $4) RETURNING id', [
          email,
          passwordHash,
          name,
          phone,
        ])
        .catch((err) => {
          if (err.code === '23505') throw new HttpError(409, 'An account with this email already exists — log in instead');
          throw err;
        });
      const { rows: t } = await c.query('INSERT INTO tenants (product_id, name) VALUES ($1, $2) RETURNING id', [
        productId,
        workspace,
      ]);
      await c.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [t[0].id, rows[0].id]);
      return rows[0].id;
    });

    await startSession(res, userId);
    res.status(201).json({ ok: true });
  });

  router.post('/login', async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    const { rows } = await query('SELECT id, password_hash FROM users WHERE lower(email) = $1', [email]);
    const ok = await checkPassword(password, rows[0]?.password_hash ?? DUMMY_HASH);
    if (!rows[0] || !ok) throw new HttpError(401, 'Wrong email or password');
    await startSession(res, rows[0].id);
    res.json({ ok: true });
  });

  router.post('/logout', async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  return router;
}

function field(value, label, max) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${label} is required`);
  if (value.trim().length > max) throw new HttpError(400, `${label} can be at most ${max} characters`);
  return value.trim();
}

function newPassword(value) {
  if (typeof value !== 'string' || value.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (value.length > 200) throw new HttpError(400, 'Password can be at most 200 characters');
  return value;
}
