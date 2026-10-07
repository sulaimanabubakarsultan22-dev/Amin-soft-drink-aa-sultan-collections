'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { assertKnownTables, openSQLiteSource, sourceRows } = require('./data-migration');
const { createDatabase } = require('./database');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amin-readonly-source-test-'));
const sourcePath = path.join(directory, 'source.db');

(async () => {
  try {
    const fixture = new DatabaseSync(sourcePath);
    fixture.exec('CREATE TABLE source_check(value TEXT); INSERT INTO source_check VALUES(\'unchanged\');');
    fixture.close();
    const originalHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');

    const source = openSQLiteSource(sourcePath);
    assert.equal(source.prepare('SELECT value FROM source_check').get().value, 'unchanged');
    assert.throws(() => source.prepare("INSERT INTO source_check VALUES('modified')").run());
    source.exec('ROLLBACK');
    source.close();

    const resultingHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
    assert.equal(resultingHash, originalHash, 'opening and reading the source does not change its file');
    console.log('PASS SQLite source is read-only and remains byte-for-byte unchanged');

    const legacyPath = path.join(directory, 'legacy.db');
    process.env.DB_PATH = legacyPath;
    delete process.env.DATABASE_URL;
    let local = await createDatabase();
    await local.close();
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      DROP TABLE annual_award_winners;
      DROP TABLE annual_award_config;
      DROP TABLE coupons;
      ALTER TABLE orders DROP COLUMN discount;
      ALTER TABLE orders DROP COLUMN coupon_code;
    `);
    legacy.prepare("INSERT INTO orders(id,no,total) VALUES(1,'ORD-LEGACY',100)").run();
    legacy.close();
    const oldSource = openSQLiteSource(legacyPath);
    assert.doesNotThrow(() => assertKnownTables(oldSource));
    const order = sourceRows(oldSource, { name: 'orders', columns: ['id', 'no', 'discount', 'coupon_code', 'total'] }, Date.now())[0];
    assert.equal(order.discount, 0);
    assert.equal(order.coupon_code, null);
    assert.equal(sourceRows(oldSource, { name: 'coupons', columns: ['code'] }, Date.now()).length, 0);
    oldSource.exec('ROLLBACK');
    oldSource.close();
    console.log('PASS existing pre-awards SQLite schema is accepted without writing to its source');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
