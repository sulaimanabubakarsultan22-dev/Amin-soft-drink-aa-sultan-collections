'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const catalog = require('./catalog.json');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'amin-catalog-test-'));
const dbPath = path.join(work, 'store.db');
const port = 43000 + (process.pid % 10000);
const env = { ...process.env, DB_PATH: dbPath, PORT: String(port), ADMIN_EMAIL: 'owner@example.test', ADMIN_PASSWORD: 'a-test-password-123', PAYSTACK_SECRET_KEY: 'sk_test_dummy', PUBLIC_URL: `http://127.0.0.1:${port}` };
delete env.DATABASE_URL;
let server;
const check = (name, value) => { assert.ok(value, name); console.log('PASS', name); };
const slug = value => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const expectedImagePath = product => `/assets/products/${slug(product.category)}/${slug(product.name)}.svg`;
const seed = () => {
  const result = spawnSync(process.execPath, ['seed-catalog.js'], { cwd: __dirname, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Catalog seed failed');
};

(async () => {
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE categories(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,active INTEGER DEFAULT 1);
      CREATE TABLE products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,sku TEXT UNIQUE,description TEXT,category TEXT,price INTEGER NOT NULL,discount INTEGER DEFAULT 0,stock INTEGER NOT NULL,active INTEGER DEFAULT 1,image TEXT,created TEXT,updated TEXT,carton_price INTEGER,carton_qty INTEGER,size TEXT,category_id INTEGER REFERENCES categories(id));`);
    for (const name of ['Soft Drinks', 'Dairy Drinks', 'Juices']) db.prepare('INSERT INTO categories(name) VALUES(?)').run(name);
    const oldProduct = db.prepare('INSERT INTO products(name,description,category,price,stock,active,created,updated,size) VALUES(?,?,?,?,?,1,?, ?,?)');
    for (const p of [
      ['Coca Cola', 'Coca Cola — unit price; carton pricing can be set in Admin.', 'Soft Drinks', 4800, 11, null],
      ['Mr V', 'Mr V — unit price; carton pricing can be set in Admin.', 'Soft Drinks', 2200, 22, null],
      ['Hollandia', 'Hollandia — provided price; unit and carton prices can be adjusted in Admin.', 'Dairy Drinks', 16500, 33, null],
      ['5Alive Big & Small', '5Alive Big & Small — provided price; carton pricing can be set in Admin.', 'Juices', 6000, 44, 'Big & Small']
    ]) oldProduct.run(...p.slice(0, 5), '2026-01-01', '2026-01-01', p[5]);
    db.close();

    seed();
    let verify = new DatabaseSync(dbPath, { readOnly: true });
    const rows = verify.prepare('SELECT name,category,price,stock,description,image FROM products ORDER BY id').all();
    check('all requested catalog entries seeded once', rows.length === catalog.products.filter(p => !p.legacy).length);
    check('legacy categories and names migrate to the requested English catalog', rows.some(p => p.name === 'Coca-Cola' && p.category === 'Drinks') && rows.some(p => p.name === 'Mr V' && p.category === 'Water') && rows.some(p => p.name === 'Hollandia Yoghurt' && p.category === 'Drinks') && rows.some(p => p.name === '5 Alive' && p.category === 'Juice'));
    check('existing prices and stock are preserved', [['Coca-Cola', 4800, 11], ['Mr V', 2200, 22], ['Hollandia Yoghurt', 16500, 33], ['5 Alive', 6000, 44]].every(([name, price, stock]) => rows.some(p => p.name === name && p.price === price && p.stock === stock)));
    const existingProducts = new Set(['Coca-Cola|Drinks', 'Mr V|Water', 'Hollandia Yoghurt|Drinks', '5 Alive|Juice']);
    check('new products start with stock of exactly 100', rows.filter(p => !existingProducts.has(`${p.name}|${p.category}`)).every(p => p.stock === 100));
    check('every seeded product has a positive price and stock plus its exact category/name image path',
      rows.every(p => p.price > 0 && p.stock > 0 && p.image === expectedImagePath(p) &&
        fs.existsSync(path.join(__dirname, 'public', p.image.slice(1)))));
    check('all eight categories are present', verify.prepare('SELECT COUNT(*) n FROM categories').get().n === 8);
    verify.close();

    const write = new DatabaseSync(dbPath);
    write.prepare("UPDATE products SET price=7777,stock=9 WHERE name='Coca-Cola' AND category='Drinks'").run();
    write.close();
    seed();
    verify = new DatabaseSync(dbPath, { readOnly: true });
    check('repeat seeding is idempotent and preserves admin price and stock changes', verify.prepare('SELECT COUNT(*) n FROM products').get().n === rows.length && verify.prepare("SELECT price=7777 AND stock=9 ok FROM products WHERE name='Coca-Cola' AND category='Drinks'").get().ok === 1);
    verify.close();

    server = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: __dirname, env, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    let listing;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await fetch(`${base}/api/products?page=1`);
        if (response.ok) { listing = await response.json(); break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    check('public catalog API serves all products and category filters', listing?.total === rows.length && listing.cats.length === catalog.categories.length);
    for (const category of listing.cats) {
      const filtered = await fetch(`${base}/api/products?cat=${category.id}`).then(response => response.json());
      check(`${category.name} category filter works`, filtered.items.length > 0 && filtered.items.every(p => p.category === category.name));
    }
    let imagesChecked = 0;
    for (let page = 1; page <= Math.ceil(listing.total / 24); page++) {
      const data = page === 1 ? listing : await fetch(`${base}/api/products?page=${page}`).then(response => response.json());
      for (const product of data.items) {
        assert.match(product.image, new RegExp(`^/img/${product.id}(?:\\?|$)`), `${product.name} image resolves through its own product id`);
        const image = await fetch(`${base}${product.image}`);
        const svg = await image.text();
        assert.equal(image.status, 200, `${product.name} illustration loads`);
        assert.match(image.headers.get('content-type') || '', /^image\/svg\+xml/);
        assert.match(svg, /<svg\b/);
        imagesChecked++;
      }
    }
    check(`all ${imagesChecked} product illustrations load through the guarded image route`, imagesChecked === listing.total);
    console.log('ALL CATALOG TESTS PASSED');
  } finally {
    if (server) server.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
