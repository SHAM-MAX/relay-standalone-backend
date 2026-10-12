import pg from 'pg';
import crypto from 'node:crypto';

let activePool = null;
let isMemoryFallback = false;

/**
 * Configure SSL based on environment and connection string.
 * Cloud-hosted PostgreSQL (Render, Neon, Supabase, AWS RDS) typically requires SSL.
 */
export function getSslConfig(connectionString) {
  if (process.env.DATABASE_SSL === 'false') return false;
  if (
    process.env.DATABASE_SSL === 'true' ||
    process.env.NODE_ENV === 'production' ||
    /sslmode=require|ssl=true/i.test(connectionString || '')
  ) {
    return { rejectUnauthorized: false };
  }

  // Detect non-local database hostnames (e.g. render.com, neon.tech, aws, supabase, etc.)
  if (connectionString) {
    try {
      const parsed = new URL(connectionString);
      const host = parsed.hostname;
      const isLocal = !host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
      if (!isLocal) {
        return { rejectUnauthorized: false };
      }
    } catch {
      // If parsing fails, fall back to false
    }
  }

  return false;
}

/**
 * Create an in-memory PostgreSQL instance for offline testing / local environments
 * when DATABASE_URL is not set.
 */
export async function createMemoryPool() {
  const { newDb } = await import('pg-mem');
  const db = newDb();
  db.public.registerFunction({
    name: 'gen_random_uuid',
    impure: true,
    implementation: () => crypto.randomUUID()
  });
  const memPg = db.adapters.createPg();
  const pool = new memPg.Pool();
  pool.__isMemoryPool = true;

  // Run migrations on the in-memory pool so tables exist
  const { runMigrations } = await import('./migrator.js');
  await runMigrations({ pool });

  return pool;
}

/**
 * Returns or initializes the database connection pool.
 */
export async function getPool() {
  if (activePool) return activePool;

  const connectionString = process.env.DATABASE_URL;

  if (connectionString) {
    const ssl = getSslConfig(connectionString);
    activePool = new pg.Pool({
      connectionString,
      ssl,
      max: Number(process.env.PG_MAX_POOL || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });

    activePool.on('error', (err) => {
      console.error('[Database Pool Error]:', err.message);
    });

    isMemoryFallback = false;
    return activePool;
  }

  // If no DATABASE_URL is provided in production, fail explicitly.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL environment variable is required in production.');
  }

  // In test / offline development mode, use in-memory PostgreSQL adapter.
  activePool = await createMemoryPool();
  isMemoryFallback = true;
  return activePool;
}

/**
 * Allows overriding or injecting a custom pool (e.g. in test suites).
 */
export function setPool(pool) {
  activePool = pool;
  isMemoryFallback = Boolean(pool?.__isMemoryPool);
}

/**
 * Execute a parameterized SQL query.
 */
export async function query(text, params) {
  const pool = await getPool();
  try {
    return await pool.query(text, params);
  } catch (error) {
    console.error('[Database Query Error]:', {
      message: error.message,
      query: text.slice(0, 120),
      code: error.code
    });
    throw error;
  }
}

/**
 * Acquire a dedicated client from the pool (for transactions).
 */
export async function getClient() {
  const pool = await getPool();
  return await pool.connect();
}

/**
 * Close and drain the connection pool.
 */
export async function closePool() {
  if (activePool) {
    await activePool.end();
    activePool = null;
    isMemoryFallback = false;
  }
}

/**
 * Database health check verifying basic query execution and measuring latency.
 */
export async function healthCheck() {
  try {
    const pool = await getPool();
    const start = Date.now();
    await pool.query('SELECT 1 AS ok');
    const latencyMs = Date.now() - start;
    return {
      ok: true,
      latencyMs,
      type: isMemoryFallback ? 'in-memory-postgres' : 'postgres'
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      type: isMemoryFallback ? 'in-memory-postgres' : 'postgres'
    };
  }
}

/**
 * Check whether a database connection is configured via DATABASE_URL.
 */
export function isConfigured() {
  return Boolean(process.env.DATABASE_URL) || Boolean(activePool);
}

export default {
  getPool,
  setPool,
  createMemoryPool,
  query,
  getClient,
  closePool,
  healthCheck,
  isConfigured
};
