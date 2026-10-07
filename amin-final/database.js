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
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,sku TEXT UNIQUE,description TEXT,category TEXT,price INTEGER NOT NULL CHECK(price>0),discount INTEGER DEFAULT 0 CHECK(discount>=0),stock INTEGER NOT NULL CHECK(stock>=0),active INTEGER DEFAULT 1,image TEXT,created TEXT,updated TEXT,carton_price INTEGER,carton_qty INTEGER,size TEXT,image_front TEXT,image_back TEXT,colors TEXT,quality TEXT,video_url TEXT,featured INTEGER DEFAULT 0,category_id INTEGER REFERENCES categories(id));
CREATE INDEX IF NOT EXISTS ix_prod ON products(category,active);
CREATE INDEX IF NOT EXISTS ix_pcat ON products(category_id);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT UNIQUE,email TEXT,created TEXT);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,no TEXT UNIQUE,customer_id INTEGER REFERENCES customers(id),address TEXT,state TEXT,city TEXT,notes TEXT,gps TEXT,subtotal INTEGER,fee INTEGER,total INTEGER,pay_status TEXT DEFAULT 'pending',status TEXT DEFAULT 'payment_pending',stocked INTEGER DEFAULT 0,created TEXT,updated TEXT,discount INTEGER NOT NULL DEFAULT 0,coupon_code TEXT,idem TEXT);
CREATE INDEX IF NOT EXISTS ix_ord ON orders(pay_status,status,customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_idem ON orders(idem);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY,order_id INTEGER REFERENCES orders(id),product_id INTEGER,name TEXT,qty INTEGER,price INTEGER,pack TEXT DEFAULT 'unit',pack_qty INTEGER DEFAULT 1);
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
    category_id: 'INTEGER REFERENCES categories(id)'
  },
  orders: { discount: 'INTEGER NOT NULL DEFAULT 0', coupon_code: 'TEXT', idem: 'TEXT' },
  order_items: { pack: "TEXT DEFAULT 'unit'", pack_qty: 'INTEGER DEFAULT 1' }
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
}

function translatePostgresSql(sql) {
  let index = 0;
  const ignoreConflict = /^\s*INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql);
  let translated = sql
    .replace(/\?/g, () => `$${++index}`)
    .replace(/\bdatetime\(([^)]+)\)/gi, 'CAST($1 AS timestamptz)')
    .replace(/strftime\('%Y',\s*verified,\s*'\+01:00'\)/gi, "EXTRACT(YEAR FROM (CAST(verified AS timestamptz) AT TIME ZONE 'Africa/Lagos'))")
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
  if (rows.some(row => row.version === '001-initial')) return;
  const sql = fs.readFileSync(path.join(migrationsDir, 'postgres', '001-initial.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations(version,applied_at) VALUES('001-initial',CURRENT_TIMESTAMP::text)");
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

module.exports = { createDatabase, translatePostgresSql, translateSQLiteSql };
