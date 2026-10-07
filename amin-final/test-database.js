'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amin-db-test-'));
process.env.DB_PATH = path.join(directory, 'isolated.db');
delete process.env.DATABASE_URL;
const { createDatabase, translatePostgresSql, translateSQLiteSql } = require('./database');
const expectedTables = [
  'admins', 'sessions', 'categories', 'products', 'customers', 'orders',
  'order_items', 'payments', 'settings', 'order_events',
  'annual_award_winners', 'annual_award_config', 'coupons', 'videos'
];

(async () => {
  try {
    assert.equal(
      translatePostgresSql('INSERT OR IGNORE INTO categories(name) VALUES(?)'),
      'INSERT INTO categories(name) VALUES($1) ON CONFLICT DO NOTHING'
    );
    assert.equal(
      translatePostgresSql('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
      'INSERT INTO settings(k,v) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET v=excluded.v'
    );
    assert.equal(
      translatePostgresSql('SELECT datetime(verified)>=datetime(?) FROM payments'),
      'SELECT CAST(verified AS timestamptz)>=CAST($1 AS timestamptz) FROM payments'
    );
    assert.match(
      translatePostgresSql("SELECT MIN(CAST(strftime('%Y',verified,'+01:00') AS INTEGER)) year FROM payments"),
      /Africa\/Lagos/
    );
    assert.equal(translateSQLiteSql('SELECT id FROM products WHERE id=? FOR UPDATE'), 'SELECT id FROM products WHERE id=?');
    let db = await createDatabase();
    assert.equal(db.type, 'sqlite');
    const tables = (await db.all("SELECT name FROM sqlite_master WHERE type='table'")).map(row => row.name);
    for (const table of expectedTables) assert.ok(tables.includes(table), `missing migrated table ${table}`);
    assert.ok((await db.all('PRAGMA foreign_key_list(orders)')).some(row => row.table === 'customers'), 'orders.customer_id relationship exists');
    await db.run('INSERT INTO categories(name) VALUES(?)', 'Migration test category');
    const inserted = await db.get('SELECT id FROM categories WHERE name=?', 'Migration test category');
    await db.close();

    db = await createDatabase();
    assert.equal((await db.get('SELECT id FROM categories WHERE name=?', 'Migration test category')).id, inserted.id, 'repeat migration preserves IDs and data');
    assert.equal((await db.get("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='schema_migrations'")).n, 0, 'SQLite migration does not add migration bookkeeping tables');
    await db.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync(process.execPath, ['scripts/migrate.js'], { cwd: __dirname, env: process.env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || 'migration CLI failed');
      assert.match(result.stdout, /Database schema is current \(sqlite\)/);
    }
    console.log('PASS isolated SQLite schema migration and idempotency');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
