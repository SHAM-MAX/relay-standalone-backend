import test from 'node:test';
import assert from 'node:assert';
import db from '../lib/db.js';
import { runMigrations } from '../lib/migrator.js';
import { hasOrigin } from '../lib/assistant-access.js';

test('OAuth Extension Origin Registration', async (t) => {
  await runMigrations();

  const validOrigin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const validOrigin2 = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const invalidOrigin = 'https://malicious.com';

  await t.test('1. Invalid origins are rejected', async () => {
    assert.strictEqual(await hasOrigin(invalidOrigin), false);
    assert.strictEqual(await hasOrigin(null), false);
    assert.strictEqual(await hasOrigin(''), false);
    assert.strictEqual(await hasOrigin('chrome-extension://short'), false);
  });

  await t.test('2. Valid format but unregistered origin is rejected (if not in env)', async () => {
    // If process.env.RELAY_EXTENSION_ID is aaaaaa... then it would pass, but we test bbb...
    assert.strictEqual(await hasOrigin(validOrigin2), false);
  });

  await t.test('3. Registering valid origin works', async () => {
    // Simulate what /api/auth/github/exchange does on successful login
    await db.query('INSERT INTO pm_extension_origins (origin) VALUES ($1) ON CONFLICT (origin) DO UPDATE SET updated_at = now()', [validOrigin2]);

    // Now it should be approved
    assert.strictEqual(await hasOrigin(validOrigin2), true);
  });

  await t.test('4. Idempotency of registration', async () => {
    // Registering again should not fail and should update timestamp
    await db.query('INSERT INTO pm_extension_origins (origin) VALUES ($1) ON CONFLICT (origin) DO UPDATE SET updated_at = now()', [validOrigin2]);
    assert.strictEqual(await hasOrigin(validOrigin2), true);
  });

  await t.test('5. Configured RELAY_EXTENSION_ID is approved', async () => {
    const prevEnv = process.env.RELAY_EXTENSION_ID;
    try {
      process.env.RELAY_EXTENSION_ID = '  ' + 'c'.repeat(32) + '  ';
      assert.strictEqual(await hasOrigin('chrome-extension://' + 'c'.repeat(32)), true);
      assert.strictEqual(await hasOrigin('chrome-extension://' + 'd'.repeat(32)), false);
    } finally {
      process.env.RELAY_EXTENSION_ID = prevEnv;
    }
  });

  await t.test('Cleanup', async () => {
    await db.closePool().catch(() => {});
  });
});
