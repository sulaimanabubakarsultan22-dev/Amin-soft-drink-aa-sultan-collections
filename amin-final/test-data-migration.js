'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { assertKnownTables, insertIdentityRows, mapReferences, openSQLiteSource, planIdentityRows, sourceRows, TABLES } = require('./data-migration');
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

    const sourceAdmin = { id: 1, name: 'Source Admin', email: 'source@example.test', hash: 'source-hash', role: 'owner', created: '2025-01-01', last_login: null, active: 1 };
    const destinationAdmin = { id: 1, name: 'Destination Admin', email: 'destination@example.test', hash: 'destination-hash', role: 'owner', created: '2025-01-01', last_login: null, active: 1 };
    const adminsTable = TABLES.find(table => table.name === 'admins');
    const remappedAdminPlan = await planIdentityRows([sourceAdmin], adminsTable, {
      get: async query => query.includes('"id" IS NOT DISTINCT FROM') ? destinationAdmin : undefined,
      all: async () => []
    });
    assert.equal(remappedAdminPlan.mappings.get(sourceAdmin.id), null);
    assert.deepEqual(remappedAdminPlan.inserts, [{ row: sourceAdmin, remapId: true }]);
    assert.equal(destinationAdmin.hash, 'destination-hash', 'a primary-key collision never changes the destination admin');
    let insertSql;
    const insertedAdmins = await insertIdentityRows(remappedAdminPlan, adminsTable, {
      get: async (sql, ...values) => {
        insertSql = sql;
        assert.ok(values.length > 0);
        return { id: 77 };
      }
    });
    assert.equal(insertedAdmins, 1);
    assert.ok(insertSql.startsWith('INSERT INTO "admins" ("name"'));
    assert.equal(remappedAdminPlan.mappings.get(sourceAdmin.id), 77);
    assert.equal(mapReferences([{ staff_id: sourceAdmin.id }], TABLES.find(table => table.name === 'videos'), new Map([['admins', remappedAdminPlan.mappings]]))[0].staff_id, 77);

    const matchingEmailAdmin = { ...destinationAdmin, id: 2, email: sourceAdmin.email };
    const existingAdminPlan = await planIdentityRows([sourceAdmin], adminsTable, {
      get: async query => query.includes('"id" IS NOT DISTINCT FROM') ? destinationAdmin : undefined,
      all: async () => [matchingEmailAdmin]
    });
    assert.equal(existingAdminPlan.mappings.get(sourceAdmin.id), matchingEmailAdmin.id);
    assert.equal(existingAdminPlan.inserts.length, 0, 'an existing account with the same email is reused without overwriting it');

    const categoryTable = TABLES.find(table => table.name === 'categories');
    const categoryPlan = await planIdentityRows(
      [{ id: 1, name: 'Juice', active: 1 }, { id: 2, name: 'Water', active: 1 }],
      categoryTable,
      {
        get: async (query, idOrName) => {
          if (idOrName === 1) return { id: 1, name: 'Other category', active: 1 };
          if (idOrName === 2) return { id: 2, name: 'Other category 2', active: 1 };
          return undefined;
        },
        all: async (query, name) => name === 'Juice' ? [{ id: 8, name: 'Juice', active: 0 }] : []
      }
    );
    assert.equal(categoryPlan.mappings.get(1), 8, 'matching category names reuse the existing PostgreSQL ID');
    assert.equal(categoryPlan.mappings.get(2), null, 'unmatched category ID collision is planned for generated ID');
    assert.deepEqual(categoryPlan.inserts, [{ row: { id: 2, name: 'Water', active: 1 }, remapId: true }]);
    assert.equal(mapReferences(
      [{ category_id: 1 }],
      TABLES.find(table => table.name === 'products'),
      new Map([['categories', categoryPlan.mappings]])
    )[0].category_id, 8);

    const productTable = TABLES.find(table => table.name === 'products');
    const product = { id: 3, sku: 'SKU-3', category_id: 8 };
    const existingProductPlan = await planIdentityRows([product], productTable, {
      get: async () => ({ ...product, name: 'Conflicting Product' }),
      all: async query => query.includes('"sku" IS NOT DISTINCT FROM') ? [{ ...product, id: 33, name: 'Existing Product' }] : []
    });
    assert.equal(existingProductPlan.mappings.get(product.id), 33, 'matching product SKUs map to destination IDs');
    assert.equal(existingProductPlan.inserts.length, 0, 'existing catalog products are never overwritten');
    const legacyProduct = { ...product, id: 4, sku: null, name: 'Legacy drink', category: 'Drinks' };
    const matchedLegacyProduct = { ...legacyProduct, id: 44, price: 2500 };
    const legacyProductPlan = await planIdentityRows([legacyProduct], productTable, {
      get: async () => undefined,
      all: async query => query.includes('"name" IS NOT DISTINCT FROM') ? [matchedLegacyProduct] : []
    });
    assert.equal(legacyProductPlan.mappings.get(legacyProduct.id), matchedLegacyProduct.id,
      'legacy products without SKUs reconcile by exact name and category');
    assert.equal(legacyProductPlan.inserts.length, 0, 'existing legacy products retain destination values');
    console.log('PASS stable identities reconcile admins, categories, customers and products with safe reference remapping');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
