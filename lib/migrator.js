import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import db from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');
const MIGRATION_LOCK_ID = 1001; // Advisory lock ID

/**
 * Ensures the schema_migrations tracking table exists.
 */
export async function ensureMigrationTable(clientOrPool) {
  const check = await clientOrPool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'schema_migrations'
    LIMIT 1;
  `);
  if (check.rows.length === 0) {
    await clientOrPool.query(`
      CREATE TABLE schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum VARCHAR(255)
      );
    `);
  } else {
    // Ensure checksum column exists for backward compatibility
    const colCheck = await clientOrPool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'schema_migrations' AND column_name = 'checksum'
    `);
    if (colCheck.rows.length === 0) {
      await clientOrPool.query(`ALTER TABLE schema_migrations ADD COLUMN checksum VARCHAR(255)`);
    }
  }
}

/**
 * Reads and sorts migration files from the migrations directory.
 */
export async function loadMigrationFiles(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  try {
    const files = await fs.readdir(migrationsDir);
    return files
      .filter((file) => file.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((file) => {
        const parts = file.split('_');
        const version = parts[0];
        const name = file.replace(/\.sql$/, '');
        return {
          filename: file,
          filepath: path.join(migrationsDir, file),
          version,
          name
        };
      });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

/**
 * Retrieves versions of already-applied migrations.
 */
export async function getAppliedVersions(clientOrPool) {
  await ensureMigrationTable(clientOrPool);
  const result = await clientOrPool.query('SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version ASC');
  return result.rows;
}

/**
 * Runs all pending migrations in order.
 */
export async function runMigrations(options = {}) {
  const pool = options.pool || await db.getPool();
  const migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;

  const files = await loadMigrationFiles(migrationsDir);

  const client = await pool.connect();
  let lockAcquired = false;

  try {
    if (!pool.__isMemoryPool) {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
      lockAcquired = true;
    }

    await ensureMigrationTable(client);

    const result = await client.query('SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version ASC');
    const appliedMap = new Map(result.rows.map((r) => [r.version, r]));

    const applied = [];
    const skipped = [];

    for (const migration of files) {
      const sql = await fs.readFile(migration.filepath, 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');

      if (appliedMap.has(migration.version)) {
        const existing = appliedMap.get(migration.version);
        if (existing.checksum) {
          if (existing.checksum !== checksum) {
            throw new Error(`Migration checksum mismatch for ${migration.filename}`);
          }
        } else {
          // Backward-compatible policy for legacy migrations:
          // Record the calculated checksum so future runs detect subsequent edits.
          // Note: Assigning a checksum to a legacy row does not verify its historical integrity;
          // it only ensures that any *future* modifications will be caught.
          await client.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [checksum, migration.version]);
          console.log(`[Migrator] Legacy migration ${migration.filename} has no checksum. Recording calculated checksum for future integrity checks.`);
        }
        skipped.push(migration);
        continue;
      }

      // Run each migration inside a dedicated transaction
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES ($1, $2, now(), $3)',
          [migration.version, migration.name, checksum]
        );
        await client.query('COMMIT');
        applied.push(migration);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[Migration Error]: Failed applying ${migration.filename}:`, err.message);
        throw new Error(`Migration ${migration.filename} failed: ${err.message}`);
      }
    }

    return {
      applied,
      skipped,
      total: files.length
    };
  } finally {
    let unlockError = null;
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
      } catch (err) {
        console.error('[Migrator] Failed to release advisory lock. Destroying connection safely.');
        unlockError = err;
      }
    }
    // client.release(truthy) instructs the pg pool to destroy the connection
    client.release(unlockError);
  }
}

/**
 * Returns current migration status for reporting or health endpoints.
 */
export async function getMigrationStatus(options = {}) {
  const pool = options.pool || await db.getPool();
  const migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;

  const files = await loadMigrationFiles(migrationsDir);
  const appliedRows = await getAppliedVersions(pool);
  const appliedMap = new Map(appliedRows.map((r) => [r.version, r]));

  return files.map((file) => ({
    version: file.version,
    name: file.name,
    filename: file.filename,
    applied: appliedMap.has(file.version),
    applied_at: appliedMap.get(file.version)?.applied_at || null,
    checksum_match: appliedMap.has(file.version) ? appliedMap.get(file.version).checksum : null
  }));
}

export default {
  ensureMigrationTable,
  loadMigrationFiles,
  getAppliedVersions,
  runMigrations,
  getMigrationStatus
};
