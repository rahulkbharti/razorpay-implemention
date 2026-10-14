import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const query = (text, params) => pool.query(text, params);

/** Runs fn(client) in a transaction: commits if it returns, rolls back if it throws. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Runs fn unless another process holds the named lock (e.g. a second server running the same job). */
export async function withLock(name, fn) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [name]);
    if (!rows[0].ok) return null;
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [name]);
    }
  } finally {
    client.release();
  }
}

// Applies each file in migrations/ once, in name order. To change the schema, add a new
// numbered file — never edit one that has already run, because it won't run again.
export async function migrate() {
  await query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
  );
  const dir = new URL('./migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  for (const file of files.filter((f) => !applied.has(f))) {
    const sql = await readFile(new URL(file, dir), 'utf8');
    await tx(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    console.log(`[db] applied ${file}`);
  }
}
