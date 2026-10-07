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
    assert.equal(
      translatePostgresSql("SELECT MIN(CAST(strftime('%Y',verified,'+01:00') AS INTEGER)) AS award_year FROM payments WHERE status='paid' AND verified IS NOT NULL"),
      "SELECT MIN(CAST(EXTRACT(YEAR FROM (CAST(verified AS timestamptz) AT TIME ZONE 'Africa/Lagos')) AS INTEGER)) AS award_year FROM payments WHERE status='paid' AND verified IS NOT NULL"
    );
    assert.equal(
      translatePostgresSql('SELECT paid_at FROM payments WHERE datetime(paid_at)>=datetime(?) AND datetime(paid_at)<datetime(?)'),
      'SELECT paid_at FROM payments WHERE CAST(paid_at AS timestamptz)>=CAST($1 AS timestamptz) AND CAST(paid_at AS timestamptz)<CAST($2 AS timestamptz)'
    );
    assert.equal(
      translatePostgresSql('SELECT CAST(? AS INTEGER)=0 OR category_id=CAST(? AS INTEGER)'),
      'SELECT CAST($1 AS INTEGER)=0 OR category_id=CAST($2 AS INTEGER)'
    );
    assert.equal(
      translatePostgresSql("SELECT CAST(? AS TEXT)='' OR status=CAST(? AS TEXT)"),
      "SELECT CAST($1 AS TEXT)='' OR status=CAST($2 AS TEXT)"
    );
    assert.equal(
      translatePostgresSql('SELECT id FROM videos WHERE active=1 AND (CAST(? AS INTEGER)=0 OR product_id=CAST(? AS INTEGER))'),
      'SELECT id FROM videos WHERE active=1 AND (CAST($1 AS INTEGER)=0 OR product_id=CAST($2 AS INTEGER))'
    );
    assert.equal(
      translatePostgresSql("SELECT o.id FROM orders o WHERE (o.no LIKE ? OR o.phone LIKE ?) AND (CAST(? AS TEXT)='' OR o.pay_status=CAST(? AS TEXT)) AND (CAST(? AS TEXT)='' OR o.status=CAST(? AS TEXT))"),
      "SELECT o.id FROM orders o WHERE (o.no LIKE $1 OR o.phone LIKE $2) AND (CAST($3 AS TEXT)='' OR o.pay_status=CAST($4 AS TEXT)) AND (CAST($5 AS TEXT)='' OR o.status=CAST($6 AS TEXT))"
    );
    assert.equal(
      translatePostgresSql('SELECT image FROM products WHERE id=? AND ((active=1) OR CAST(? AS INTEGER)=1)'),
      'SELECT image FROM products WHERE id=$1 AND ((active=1) OR CAST($2 AS INTEGER)=1)'
    );
    assert.equal(
      translatePostgresSql('SELECT id FROM products ORDER BY lower(name)=lower(CAST(? AS TEXT)) LIMIT 24 OFFSET CAST(? AS INTEGER)'),
      'SELECT id FROM products ORDER BY lower(name)=lower(CAST($1 AS TEXT)) LIMIT 24 OFFSET CAST($2 AS INTEGER)'
    );
    assert.equal(translateSQLiteSql('SELECT id FROM products WHERE id=? FOR UPDATE'), 'SELECT id FROM products WHERE id=?');
    let db = await createDatabase();
    assert.equal(db.type, 'sqlite');
    const tables = (await db.all("SELECT name FROM sqlite_master WHERE type='table'")).map(row => row.name);
    for (const table of expectedTables) assert.ok(tables.includes(table), `missing migrated table ${table}`);
    assert.ok((await db.all('PRAGMA foreign_key_list(orders)')).some(row => row.table === 'customers'), 'orders.customer_id relationship exists');
    assert.equal((await db.get('SELECT CAST(? AS INTEGER)=0 enabled', 0)).enabled, 1, 'explicit parameter casts remain SQLite-compatible');
    assert.equal((await db.get('SELECT (0=1 OR CAST(? AS INTEGER)=1) enabled', 1)).enabled, 1,
      'the image authorization predicate remains SQLite-compatible');
    assert.equal((await db.get("SELECT MIN(CAST(strftime('%Y',?,'+01:00') AS INTEGER)) AS award_year", '2025-12-31T23:30:00Z')).award_year, 2026,
      'the award year remains evaluated in Lagos local time on SQLite');
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
