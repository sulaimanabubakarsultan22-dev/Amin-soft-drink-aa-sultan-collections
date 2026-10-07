'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// DATABASE_URL_TEST must point to a dedicated test database; this test applies the app migrations.
if (!process.env.DATABASE_URL_TEST) {
  console.log('SKIP PostgreSQL integration test (DATABASE_URL_TEST is not set)');
  process.exit(0);
}

const { createDatabase } = require('./database');
const { migrateSQLiteToPostgres } = require('./data-migration');
const requiredTables = [
  'admins', 'sessions', 'categories', 'products', 'customers', 'orders',
  'order_items', 'payments', 'settings', 'order_events',
  'annual_award_winners', 'annual_award_config', 'coupons', 'videos'
];

function makeSource(sourcePath, baseId, changedAdmin = false) {
  const source = new (require('node:sqlite').DatabaseSync)(sourcePath);
  source.exec(`
    CREATE TABLE admins(id INTEGER PRIMARY KEY,name TEXT,email TEXT UNIQUE,hash TEXT,role TEXT,created TEXT,last_login TEXT,active INTEGER DEFAULT 1);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,admin_id INTEGER REFERENCES admins(id),expires INTEGER);
    CREATE TABLE categories(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,active INTEGER DEFAULT 1);
    CREATE TABLE products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,sku TEXT UNIQUE,description TEXT,category TEXT,price INTEGER NOT NULL,discount INTEGER DEFAULT 0,stock INTEGER NOT NULL,active INTEGER DEFAULT 1,image TEXT,created TEXT,updated TEXT,carton_price INTEGER,carton_qty INTEGER,size TEXT,image_front TEXT,image_back TEXT,colors TEXT,quality TEXT,video_url TEXT,featured INTEGER DEFAULT 0,category_id INTEGER REFERENCES categories(id));
    CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT UNIQUE,email TEXT,created TEXT);
    CREATE TABLE orders(id INTEGER PRIMARY KEY,no TEXT UNIQUE,customer_id INTEGER REFERENCES customers(id),address TEXT,state TEXT,city TEXT,notes TEXT,gps TEXT,subtotal INTEGER,fee INTEGER,total INTEGER,pay_status TEXT DEFAULT 'pending',status TEXT DEFAULT 'payment_pending',stocked INTEGER DEFAULT 0,created TEXT,updated TEXT,discount INTEGER NOT NULL DEFAULT 0,coupon_code TEXT,idem TEXT);
    CREATE TABLE order_items(id INTEGER PRIMARY KEY,order_id INTEGER REFERENCES orders(id),product_id INTEGER,name TEXT,qty INTEGER,price INTEGER,pack TEXT DEFAULT 'unit',pack_qty INTEGER DEFAULT 1);
    CREATE TABLE payments(id INTEGER PRIMARY KEY,order_id INTEGER REFERENCES orders(id),provider TEXT,reference TEXT UNIQUE,amount INTEGER,currency TEXT,status TEXT,response TEXT,created TEXT,verified TEXT);
    CREATE TABLE settings(k TEXT PRIMARY KEY,v TEXT);
    CREATE TABLE order_events(id INTEGER PRIMARY KEY,order_id INTEGER REFERENCES orders(id),label TEXT,at TEXT);
    CREATE TABLE annual_award_winners(year INTEGER NOT NULL,rank INTEGER NOT NULL,customer_id INTEGER,name TEXT NOT NULL,spend INTEGER NOT NULL,paid_orders INTEGER NOT NULL,PRIMARY KEY(year,rank));
    CREATE TABLE annual_award_config(id INTEGER PRIMARY KEY CHECK(id=1),reward TEXT NOT NULL DEFAULT '');
    CREATE TABLE coupons(code TEXT PRIMARY KEY,percent INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,created TEXT NOT NULL);
    CREATE TABLE videos(id INTEGER PRIMARY KEY,title TEXT NOT NULL,description TEXT,product_id INTEGER, url TEXT NOT NULL,staff_id INTEGER,active INTEGER DEFAULT 1,created TEXT,updated TEXT);
  `);
  const adminId = baseId, inactiveAdminId = baseId + 1, categoryId = baseId + 2, productId = baseId + 3;
  const customerId = baseId + 4, orderId = baseId + 5, itemId = baseId + 6;
  const paymentId = baseId + 7, eventId = baseId + 8, videoId = baseId + 9;
  const created = new Date().toISOString();
  source.prepare('INSERT INTO admins(id,name,email,hash,role,created,active) VALUES(?,?,?,?,?,?,1)')
    .run(adminId, changedAdmin ? 'Changed Test Admin' : 'Test Admin', `migration-${baseId}@example.test`, `dummy-hash-${baseId}`, 'owner', created);
  source.prepare('INSERT INTO admins(id,name,email,hash,role,created,active) VALUES(?,?,?,?,?,?,0)')
    .run(inactiveAdminId, 'Inactive Test Admin', `inactive-${baseId}@example.test`, `dummy-inactive-hash-${baseId}`, 'staff', created);
  source.prepare('INSERT INTO sessions(token_hash,admin_id,expires) VALUES(?,?,?)')
    .run(`active-token-hash-${baseId}`, adminId, Date.now() + 86_400_000);
  source.prepare('INSERT INTO sessions(token_hash,admin_id,expires) VALUES(?,?,?)')
    .run(`expired-token-hash-${baseId}`, adminId, Date.now() - 1000);
  source.prepare('INSERT INTO sessions(token_hash,admin_id,expires) VALUES(?,?,?)')
    .run(`inactive-admin-token-hash-${baseId}`, inactiveAdminId, Date.now() + 86_400_000);
  source.prepare('INSERT INTO categories(id,name,active) VALUES(?,?,1)').run(categoryId, `Migration category ${baseId}`);
  source.prepare(`INSERT INTO products(id,name,sku,description,category,price,discount,stock,active,image,created,updated,image_front,image_back,featured,category_id)
    VALUES(?,?,?,?,?,1000,0,7,1,?,?,?, ?, ?,1,?)`)
    .run(productId, 'Migration test product', `MIG-${baseId}`, 'Test description', `Migration category ${baseId}`,
      '/assets/products/drinks/test-product.svg', created, created, 'data:image/png;base64,test-front', 'data:image/png;base64,test-back', categoryId);
  source.prepare('INSERT INTO customers(id,name,phone,email,created) VALUES(?,?,?,?,?)')
    .run(customerId, 'Test Customer', `migration-${baseId}`, 'customer@example.test', created);
  source.prepare(`INSERT INTO orders(id,no,customer_id,address,state,city,subtotal,fee,total,pay_status,status,stocked,created,updated,discount,coupon_code,idem)
    VALUES(?,?,?,'1 Test Street','Lagos','Ikeja',1000,2000,3000,'paid','paid',1,?,?,0,NULL,?)`)
    .run(orderId, `ORD-${baseId.toString(16).toUpperCase()}`, customerId, created, created, `migration-idem-${baseId}`);
  source.prepare('INSERT INTO order_items(id,order_id,product_id,name,qty,price,pack,pack_qty) VALUES(?,?,?,?,1,1000,?,1)')
    .run(itemId, orderId, productId, 'Migration test product', 'unit');
  source.prepare('INSERT INTO payments(id,order_id,provider,reference,amount,currency,status,response,created,verified) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(paymentId, orderId, 'paystack', `MIG-REF-${baseId}`, 3000, 'NGN', 'paid', '{"status":"verified"}', created, created);
  source.prepare('INSERT INTO settings(k,v) VALUES(?,?)').run(`migration.${baseId}`, 'test-setting');
  source.prepare('INSERT INTO order_events(id,order_id,label,at) VALUES(?,?,?,?)').run(eventId, orderId, 'Order placed', created);
  source.prepare('INSERT INTO annual_award_winners(year,rank,customer_id,name,spend,paid_orders) VALUES(2025,1,?,?,3000,1)')
    .run(customerId, 'Test Customer');
  source.prepare('INSERT INTO annual_award_config(id,reward) VALUES(1,?)').run(`Test reward ${baseId}`);
  source.prepare('INSERT INTO coupons(code,percent,active,created) VALUES(?,10,1,?)').run(`MIG-${baseId}`, created);
  source.prepare('INSERT INTO videos(id,title,description,product_id,url,staff_id,active,created,updated) VALUES(?,?,?,?,?,?,1,?,?)')
    .run(videoId, 'Test video', 'Test description', productId, 'https://example.test/video', adminId, created, created);
  source.close();
}

(async () => {
  const previousUrl = process.env.DATABASE_URL;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'amin-pg-data-migration-test-'));
  const sourcePath = path.join(work, 'source.db');
  const conflictPath = path.join(work, 'conflict.db');
  const baseId = 1_000_000_000 + crypto.randomInt(0, 500_000_000);
  const adminId = baseId, productId = baseId + 3, customerId = baseId + 4, orderId = baseId + 5;
  let db;
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  try {
    db = await createDatabase();
    assert.equal(db.type, 'postgres');
    const tables = new Set((await db.all("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()")).map(row => row.table_name));
    for (const table of [...requiredTables, 'schema_migrations']) assert.ok(tables.has(table), `missing PostgreSQL table ${table}`);
    assert.ok((await db.all("SELECT column_name FROM information_schema.columns WHERE table_name='products'")).some(row => row.column_name === 'category_id'), 'products.category_id relationship exists');
    assert.equal((await db.get("SELECT COUNT(*)::integer AS count FROM schema_migrations WHERE version='001-initial'")).count, 1, 'repeat PostgreSQL migration is idempotent');
    makeSource(sourcePath, baseId);

    let result = await migrateSQLiteToPostgres({ sourcePath, destination: db, dryRun: true });
    assert.equal(result.find(row => row.table === 'sessions').sourceRows, 1, 'only unexpired active-admin sessions are selected');
    assert.ok(result.find(row => row.table === 'annual_award_config').alreadyPresentRows === 0, 'bootstrap award configuration can be populated');
    assert.equal(await db.get('SELECT id FROM admins WHERE id=?', adminId), undefined, 'dry-run does not write destination data');

    result = await migrateSQLiteToPostgres({ sourcePath, destination: db, dryRun: false });
    assert.ok(result.every(row => row.insertedRows === row.sourceRows), 'first import writes each source row once');
    assert.equal((await db.get('SELECT category_id FROM products WHERE id=?', productId)).category_id, baseId + 2);
    assert.equal((await db.get('SELECT image FROM products WHERE id=?', productId)).image, '/assets/products/drinks/test-product.svg');
    assert.equal((await db.get('SELECT image_front FROM products WHERE id=?', productId)).image_front, 'data:image/png;base64,test-front');
    assert.equal((await db.get('SELECT pay_status,status FROM orders WHERE id=?', orderId)).pay_status, 'paid');
    assert.equal((await db.get('SELECT product_id FROM order_items WHERE order_id=?', orderId)).product_id, productId);
    assert.equal((await db.get('SELECT status FROM payments WHERE order_id=?', orderId)).status, 'paid');
    assert.equal((await db.get('SELECT reward FROM annual_award_config WHERE id=1')).reward, `Test reward ${baseId}`);
    assert.equal((await db.get('SELECT COUNT(*)::integer AS count FROM sessions WHERE admin_id=?', adminId)).count, 1);
    assert.equal((await db.get('SELECT COUNT(*)::integer AS count FROM sessions WHERE token_hash LIKE ?', `expired-token-hash-${baseId}`)).count, 0);

    result = await migrateSQLiteToPostgres({ sourcePath, destination: db, dryRun: false });
    assert.ok(result.every(row => row.insertedRows === 0), 'repeat import creates no duplicates');
    fs.copyFileSync(sourcePath, conflictPath);
    const conflictSource = new (require('node:sqlite').DatabaseSync)(conflictPath);
    conflictSource.prepare('UPDATE admins SET name=? WHERE id=?').run('Conflicting admin name', adminId);
    conflictSource.close();
    await assert.rejects(
      migrateSQLiteToPostgres({ sourcePath: conflictPath, destination: db, dryRun: false }),
      error => error.name === 'MigrationError' && error.table === 'admins'
    );
    assert.equal((await db.get('SELECT name FROM admins WHERE id=?', adminId)).name, 'Test Admin', 'conflict does not overwrite destination data');
    console.log('PASS isolated PostgreSQL schema/data migration, dry-run, validation, repeat import and conflict protection');
  } finally {
    if (db) {
      await db.run('DELETE FROM sessions WHERE admin_id=?', adminId);
      await db.run('DELETE FROM videos WHERE id=?', baseId + 9);
      await db.run('DELETE FROM order_events WHERE id=?', baseId + 8);
      await db.run('DELETE FROM payments WHERE id=?', baseId + 7);
      await db.run('DELETE FROM order_items WHERE id=?', baseId + 6);
      await db.run('DELETE FROM orders WHERE id=?', orderId);
      await db.run('DELETE FROM annual_award_winners WHERE customer_id=?', customerId);
      await db.run('DELETE FROM annual_award_config WHERE id=1');
      await db.run('INSERT INTO annual_award_config(id,reward) VALUES(1,\'\') ON CONFLICT(id) DO UPDATE SET reward=\'\'');
      await db.run('DELETE FROM settings WHERE k=?', `migration.${baseId}`);
      await db.run('DELETE FROM coupons WHERE code=?', `MIG-${baseId}`);
      await db.run('DELETE FROM products WHERE id=?', productId);
      await db.run('DELETE FROM categories WHERE id=?', baseId + 2);
      await db.run('DELETE FROM customers WHERE id=?', customerId);
      await db.run('DELETE FROM admins WHERE id IN (?,?)', adminId, adminId + 1);
      await db.close();
    }
    fs.rmSync(work, { recursive: true, force: true });
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
