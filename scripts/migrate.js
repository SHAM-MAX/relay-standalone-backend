#!/usr/bin/env node
import dotenv from 'dotenv';
import db from '../lib/db.js';
import { runMigrations, getMigrationStatus } from '../lib/migrator.js';

dotenv.config();

async function main() {
  const command = process.argv[2] || 'up';

  console.log('--- Relay Database Migrations ---');

  if (command === 'status') {
    const status = await getMigrationStatus();
    console.log('Migration Status:');
    if (status.length === 0) {
      console.log('  No migration files found.');
    } else {
      status.forEach((m) => {
        const marker = m.applied ? '[OK] APPLIED ' : '[  ] PENDING';
        console.log(`  ${marker} - ${m.filename} ${m.applied_at ? `(${m.applied_at.toISOString()})` : ''}`);
      });
    }
    await db.closePool();
    return;
  }

  if (command === 'up') {
    console.log('Applying pending migrations...');
    const result = await runMigrations();
    if (result.applied.length === 0) {
      console.log(`All ${result.total} migrations are already up-to-date.`);
    } else {
      result.applied.forEach((m) => {
        console.log(`  [OK] Applied: ${m.filename}`);
      });
      console.log(`Successfully applied ${result.applied.length} migration(s). Total: ${result.total}.`);
    }
    await db.closePool();
    return;
  }

  console.error(`Unknown command: ${command}. Use 'up' or 'status'.`);
  process.exit(1);
}

main().catch(async (err) => {
  console.error('[Migration Failed]:', err.message);
  await db.closePool().catch(() => {});
  process.exit(1);
});
