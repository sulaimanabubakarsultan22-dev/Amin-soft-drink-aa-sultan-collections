'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DatabaseSync } = require('node:sqlite');
const { Pool, types } = require('pg');

types.setTypeParser(20, value => Number(value));
types.setTypeParser(1700, value => Number(value));

const migrationsDir = path.join(__dirname, 'migrations');
const sqliteTables = `
CREATE TABLE IF NOT EXISTS admins(id INTEGER PRIMARY KEY,name TEXT,email TEXT UNIQUE,hash TEXT,role TEXT,created TEXT,last_login TEXT,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,admin_id INTEGER REFERENCES admins(id),expires INTEGER);
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,sku TEXT UNIQUE,description TEXT,category TEXT,product_type TEXT NOT NULL DEFAULT 'GOODS' CHECK(product_type IN ('DRINK','CLOTHING','GOODS')),price INTEGER NOT NULL CHECK(price>0),discount INTEGER DEFAULT 0 CHECK(discount>=0),stock INTEGER NOT NULL CHECK(stock>=0),active INTEGER DEFAULT 1,image TEXT,created TEXT,updated TEXT,carton_price INTEGER,carton_qty INTEGER,size TEXT,image_front TEXT,image_back TEXT,colors TEXT,quality TEXT,video_url TEXT,featured INTEGER DEFAULT 0,category_id INTEGER REFERENCES categories(id),style TEXT,best_seller INTEGER NOT NULL DEFAULT 0,new_arrival INTEGER NOT NULL DEFAULT 0,flash_deal INTEGER NOT NULL DEFAULT 0,low_stock INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_prod ON products(category,active);
CREATE INDEX IF NOT EXISTS ix_pcat ON products(category_id);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT UNIQUE,email TEXT,created TEXT);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,no TEXT UNIQUE,customer_id INTEGER REFERENCES customers(id),address TEXT,state TEXT,city TEXT,notes TEXT,gps TEXT,subtotal INTEGER,fee INTEGER,total INTEGER,pay_status TEXT DEFAULT 'pending',status TEXT DEFAULT 'payment_pending',stocked INTEGER DEFAULT 0,created TEXT,updated TEXT,discount INTEGER NOT NULL DEFAULT 0,coupon_code TEXT,idem TEXT,delivery_option TEXT NOT NULL DEFAULT 'standard');
CREATE INDEX IF NOT EXISTS ix_ord ON orders(pay_status,status,customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_idem ON orders(idem);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY,order_id INTEGER REFERENCES orders(id),product_id INTEGER,name TEXT,qty INTEGER,price INTEGER,pack TEXT DEFAULT 'unit',pack_qty INTEGER DEFAULT 1,variant TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY,order_id INTEGER REFERENCES orders(id),provider TEXT,reference TEXT UNIQUE,amount INTEGER,currency TEXT,status TEXT,response TEXT,created TEXT,verified TEXT);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT);
CREATE TABLE IF NOT EXISTS order_events(id INTEGER PRIMARY KEY,order_id INTEGER REFERENCES orders(id),label TEXT,at TEXT);
CREATE TABLE IF NOT EXISTS annual_award_winners(year INTEGER NOT NULL,rank INTEGER NOT NULL,customer_id INTEGER,name TEXT NOT NULL,spend INTEGER NOT NULL,paid_orders INTEGER NOT NULL,PRIMARY KEY(year,rank));
CREATE TABLE IF NOT EXISTS annual_award_config(id INTEGER PRIMARY KEY CHECK(id=1),reward TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS coupons(code TEXT PRIMARY KEY,percent INTEGER NOT NULL CHECK(percent BETWEEN 1 AND 75),active INTEGER NOT NULL DEFAULT 1,created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS videos(id INTEGER PRIMARY KEY,title TEXT NOT NULL,description TEXT,product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,url TEXT NOT NULL,staff_id INTEGER REFERENCES admins(id),active INTEGER DEFAULT 1,created TEXT,updated TEXT);
CREATE INDEX IF NOT EXISTS ix_videos ON videos(active,created);`;

const sqliteColumns = {
  admins: { active: 'INTEGER DEFAULT 1' },
  products: {
    carton_price: 'INTEGER', carton_qty: 'INTEGER', size: 'TEXT',
    image_front: 'TEXT', image_back: 'TEXT', colors: 'TEXT',
    quality: 'TEXT', video_url: 'TEXT', featured: 'INTEGER DEFAULT 0',
    category_id: 'INTEGER REFERENCES categories(id)',
    product_type: "TEXT NOT NULL DEFAULT 'GOODS' CHECK(product_type IN ('DRINK','CLOTHING','GOODS'))",
    style: 'TEXT', best_seller: 'INTEGER NOT NULL DEFAULT 0',
    new_arrival: 'INTEGER NOT NULL DEFAULT 0', flash_deal: 'INTEGER NOT NULL DEFAULT 0',
    low_stock: 'INTEGER NOT NULL DEFAULT 0'
  },
  orders: { discount: 'INTEGER NOT NULL DEFAULT 0', coupon_code: 'TEXT', idem: 'TEXT', delivery_option: "TEXT NOT NULL DEFAULT 'standard'" },
  order_items: { pack: "TEXT DEFAULT 'unit'", pack_qty: 'INTEGER DEFAULT 1', variant: "TEXT NOT NULL DEFAULT '{}'" }
};

function sqliteColumnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

function translateSQLiteSql(sql) {
  return sql.replace(/\s+FOR UPDATE\b/gi, '');
}

function migrateSQLite(db) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  db.exec(sqliteTables);
  const classifyProductTypes = !sqliteColumnExists(db, 'products', 'product_type');
  for (const [table, columns] of Object.entries(sqliteColumns)) {
    for (const [column, type] of Object.entries(columns)) {
      if (!sqliteColumnExists(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  db.exec("INSERT OR IGNORE INTO annual_award_config(id,reward) VALUES(1,'');");
  for (const row of db.prepare("SELECT DISTINCT category FROM products WHERE category<>'' AND category_id IS NULL").all()) {
    db.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)').run(row.category);
    db.prepare('UPDATE products SET category_id=(SELECT id FROM categories WHERE name=?) WHERE category=? AND category_id IS NULL').run(row.category, row.category);
  }
  if (classifyProductTypes) {
    db.exec(`UPDATE products SET product_type=CASE
      WHEN lower(COALESCE(name,'')) LIKE '%thread%' OR lower(COALESCE(name,'')) LIKE '%needle%' OR lower(COALESCE(name,'')) LIKE '%zipper%' OR lower(COALESCE(name,'')) LIKE '%button%' OR lower(COALESCE(name,'')) LIKE '%tape%' OR lower(COALESCE(name,'')) LIKE '%chalk%' OR lower(COALESCE(name,'')) LIKE '%elastic%' OR lower(COALESCE(name,'')) LIKE '%fabric%' OR lower(COALESCE(name,'')) LIKE '%scissor%' OR lower(COALESCE(name,'')) LIKE '%bobbin%' OR lower(COALESCE(name,'')) LIKE '%bead%' OR lower(COALESCE(name,'')) LIKE '%sequin%' OR lower(COALESCE(name,'')) LIKE '%trimming%' THEN 'GOODS'
      WHEN lower(COALESCE(category,'')) LIKE '%drink%' OR lower(COALESCE(category,'')) LIKE '%juice%' OR lower(COALESCE(category,'')) LIKE '%water%' THEN 'DRINK'
      WHEN lower(COALESCE(category,'')) LIKE '%cloth%' OR lower(COALESCE(category,'')) LIKE '%fashion%' OR lower(COALESCE(category,'')) LIKE '%apparel%' OR lower(COALESCE(category,'')) LIKE '%wear%' OR lower(COALESCE(category,'')) LIKE '%maza%' OR lower(COALESCE(category,'')) LIKE '%mata%' OR lower(COALESCE(category,'')) LIKE '%yara%' OR lower(COALESCE(category,'')) LIKE '%riguna%' OR lower(COALESCE(category,'')) LIKE '%baby%' OR lower(COALESCE(category,'')) LIKE '%kids%' THEN 'CLOTHING'
      ELSE 'GOODS' END`);
  }
}

function translatePostgresSql(sql) {
  let index = 0;
  const ignoreConflict = /^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql);
  let translated = '';
  let quote;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const character = sql[i], next = sql[i + 1];
    if (lineComment) {
      translated += character;
      if (character === '\n') lineComment = false;
    } else if (blockComment) {
      translated += character;
      if (character === '*' && next === '/') {
        translated += next;
        i++;
        blockComment = false;
      }
    } else if (quote) {
      translated += character;
      if (character === quote) {
        if (next === quote) {
          translated += next;
          i++;
        } else {
          quote = undefined;
        }
      }
    } else if ((character === '-' && next === '-') || (character === '/' && next === '*')) {
      translated += character + next;
      i++;
      lineComment = character === '-';
      blockComment = character === '/';
    } else if (character === "'" || character === '"' || character === '`' || character === '[') {
      quote = character === '[' ? ']' : character;
      translated += character;
    } else {
      translated += character === '?' ? `$${++index}` : character;
    }
  }
  translated = translated
    .replace(/\bdatetime\(([^)]+)\)/gi, 'CAST($1 AS timestamptz)')
    .replace(/strftime\('%Y',\s*verified,\s*'\+01:00'\)/gi, "TO_CHAR((CAST(verified AS timestamptz) AT TIME ZONE 'Africa/Lagos'), 'YYYY')")
    .replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
  if (ignoreConflict) translated = translated.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
  return translated;
}

function createDatabase({ migrate = true } = {}) {
  const transactionContext = new AsyncLocalStorage();
  let backend;
  let queue = Promise.resolve();

  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    backend = {
      type: 'postgres',
      async exec(sql) {
        const client = transactionContext.getStore();
        await (client || pool).query(sql);
      },
      async get(sql, ...params) {
        try {
          const result = await (transactionContext.getStore() || pool).query(translatePostgresSql(sql), params);
          return result.rows[0];
        } catch (error) {
          normalizePostgresError(error);
          throw error;
        }
      },
      async all(sql, ...params) {
        try {
          const result = await (transactionContext.getStore() || pool).query(translatePostgresSql(sql), params);
          return result.rows;
        } catch (error) {
          normalizePostgresError(error);
          throw error;
        }
      },
      async run(sql, ...params) {
        try {
          const result = await (transactionContext.getStore() || pool).query(translatePostgresSql(sql), params);
          return { changes: result.rowCount };
        } catch (error) {
          normalizePostgresError(error);
          throw error;
        }
      },
      async advisoryLock(key) {
        const client = transactionContext.getStore();
        if (!client) throw new Error('PostgreSQL advisory locks require an active transaction');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      },
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const value = await transactionContext.run(client, fn);
          await client.query('COMMIT');
          return value;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'Database transaction and rollback both failed');
          }
          throw error;
        } finally {
          client.release();
        }
      },
      async close() { await pool.end(); }
    };
    return (migrate ? migratePostgres(pool) : Promise.resolve())
      .then(() => backend)
      .catch(async error => {
        await pool.end();
        throw error;
      });
  }

  const sqlite = new DatabaseSync(process.env.DB_PATH || 'store.db');
  migrateSQLite(sqlite);
  const execute = fn => {
    const context = transactionContext.getStore();
    if (context) return Promise.resolve().then(fn);
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  backend = {
    type: 'sqlite',
    exec(sql) { return execute(() => sqlite.exec(sql)); },
    get(sql, ...params) { return execute(() => sqlite.prepare(translateSQLiteSql(sql)).get(...params)); },
    all(sql, ...params) { return execute(() => sqlite.prepare(translateSQLiteSql(sql)).all(...params)); },
    run(sql, ...params) { return execute(() => sqlite.prepare(translateSQLiteSql(sql)).run(...params)); },
    async advisoryLock() {},
    async transaction(fn) {
      const previous = queue;
      let release;
      queue = new Promise(resolve => { release = resolve; });
      await previous;
      const context = {};
      try {
        sqlite.exec('BEGIN IMMEDIATE');
        const value = await transactionContext.run(context, fn);
        sqlite.exec('COMMIT');
        return value;
      } catch (error) {
        try {
          sqlite.exec('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Database transaction and rollback both failed');
        }
        throw error;
      } finally {
        release();
      }
    },
    async close() { await execute(() => sqlite.close()); }
  };
  return Promise.resolve(backend);
}

function normalizePostgresError(error) {
  if (error.code === '23505') error.message = 'UNIQUE constraint failed';
}

async function migratePostgres(pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map(row => row.version));
  for (const version of ['001-initial', '002-product-types-and-order-variants', '003-marketplace-merchandising', '004-low-stock-control']) {
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, 'postgres', `${version}.sql`), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version,applied_at) VALUES($1,CURRENT_TIMESTAMP::text)', [version]);
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Schema migration and rollback both failed');
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { createDatabase, translatePostgresSql, translateSQLiteSql };
