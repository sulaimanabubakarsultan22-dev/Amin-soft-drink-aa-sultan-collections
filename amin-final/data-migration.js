'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const TABLES = [
  { name: 'admins', key: ['id'], columns: ['id', 'name', 'email', 'hash', 'role', 'created', 'last_login', 'active'], unique: [['email']] },
  { name: 'categories', key: ['id'], columns: ['id', 'name', 'active'], unique: [['name']] },
  { name: 'customers', key: ['id'], columns: ['id', 'name', 'phone', 'email', 'created'], unique: [['phone']] },
  { name: 'products', key: ['id'], columns: ['id', 'name', 'sku', 'description', 'category', 'price', 'discount', 'stock', 'active', 'image', 'created', 'updated', 'carton_price', 'carton_qty', 'size', 'image_front', 'image_back', 'colors', 'quality', 'video_url', 'featured', 'category_id'], unique: [['sku']] },
  { name: 'sessions', key: ['token_hash'], columns: ['token_hash', 'admin_id', 'expires'] },
  { name: 'orders', key: ['id'], columns: ['id', 'no', 'customer_id', 'address', 'state', 'city', 'notes', 'gps', 'subtotal', 'fee', 'total', 'pay_status', 'status', 'stocked', 'created', 'updated', 'discount', 'coupon_code', 'idem'], unique: [['no'], ['idem']] },
  { name: 'order_items', key: ['id'], columns: ['id', 'order_id', 'product_id', 'name', 'qty', 'price', 'pack', 'pack_qty'] },
  { name: 'payments', key: ['id'], columns: ['id', 'order_id', 'provider', 'reference', 'amount', 'currency', 'status', 'response', 'created', 'verified'], unique: [['reference']] },
  { name: 'order_events', key: ['id'], columns: ['id', 'order_id', 'label', 'at'] },
  { name: 'settings', key: ['k'], columns: ['k', 'v'] },
  { name: 'annual_award_winners', key: ['year', 'rank'], columns: ['year', 'rank', 'customer_id', 'name', 'spend', 'paid_orders'] },
  { name: 'annual_award_config', key: ['id'], columns: ['id', 'reward'] },
  { name: 'coupons', key: ['code'], columns: ['code', 'percent', 'active', 'created'] },
  { name: 'videos', key: ['id'], columns: ['id', 'title', 'description', 'product_id', 'url', 'staff_id', 'active', 'created', 'updated'] }
];

const RELATIONSHIPS = [
  ['sessions', 'admin_id', 'admins'],
  ['products', 'category_id', 'categories'],
  ['orders', 'customer_id', 'customers'],
  ['order_items', 'order_id', 'orders'],
  ['order_items', 'product_id', 'products'],
  ['payments', 'order_id', 'orders'],
  ['order_events', 'order_id', 'orders'],
  ['annual_award_winners', 'customer_id', 'customers'],
  ['videos', 'product_id', 'products'],
  ['videos', 'staff_id', 'admins']
];
const OPTIONAL_TABLES = new Set(['annual_award_winners', 'annual_award_config', 'coupons']);
const SOURCE_DEFAULTS = {
  orders: { discount: '0', coupon_code: 'NULL' }
};

class MigrationError extends Error {
  constructor(message, table) {
    super(message);
    this.name = 'MigrationError';
    this.table = table;
  }
}

function openSQLiteSource(sourcePath) {
  const absolutePath = path.resolve(sourcePath);
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) throw new Error('SQLite source must be a regular database file');
  const source = new DatabaseSync(absolutePath, { readOnly: true });
  try {
    source.exec('PRAGMA query_only=ON; BEGIN;');
    return source;
  } catch (error) {
    source.close();
    throw error;
  }
}

function assertKnownTables(source) {
  const existing = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name));
  const expected = new Set(TABLES.map(table => table.name));
  const ignored = new Set(['schema_migrations']);
  const unknown = [...existing].filter(name => !expected.has(name) && !ignored.has(name));
  const missing = [...expected].filter(name => !existing.has(name) && !OPTIONAL_TABLES.has(name));
  if (unknown.length) throw new MigrationError('Source contains application tables not covered by this migration');
  if (missing.length) throw new MigrationError('Source does not have the complete current application schema');
  for (const table of TABLES) {
    if (!existing.has(table.name)) continue;
    const columns = new Set(source.prepare(`PRAGMA table_info("${table.name}")`).all().map(row => row.name));
    const missingRequired = table.columns.some(column =>
      !columns.has(column) && SOURCE_DEFAULTS[table.name]?.[column] === undefined
    );
    if (missingRequired) throw new MigrationError('Source table is missing required application columns', table.name);
  }
}

function sourceRows(source, table, now) {
  const exists = source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table.name);
  if (!exists) return [];
  if (table.name === 'sessions') {
    return source.prepare(`SELECT s.token_hash,s.admin_id,s.expires FROM sessions s
      JOIN admins a ON a.id=s.admin_id
      WHERE s.expires>? AND COALESCE(a.active,1)=1`).all(now);
  }
  const availableColumns = new Set(source.prepare(`PRAGMA table_info("${table.name}")`).all().map(row => row.name));
  const projections = table.columns.map(column =>
    availableColumns.has(column)
      ? `"${column}"`
      : `${SOURCE_DEFAULTS[table.name][column]} AS "${column}"`
  );
  return source.prepare(`SELECT ${projections.join(',')} FROM "${table.name}"`).all();
}

function keyWhere(columns) {
  return columns.map(column => `"${column}" IS NOT DISTINCT FROM ?`).join(' AND ');
}

function valuesMatch(left, right, columns) {
  return columns.every(column => {
    const a = left[column], b = right[column];
    if (a == null || b == null) return a == null && b == null;
    if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
    return String(a) === String(b);
  });
}

async function preflightTable(sourceRowsForTable, table, destination) {
  const conflicts = [];
  let notPresent = 0;
  for (const sourceRow of sourceRowsForTable) {
    const keyParams = table.key.map(column => sourceRow[column]);
    const found = await destination.get(
      `SELECT ${table.columns.map(column => `"${column}"`).join(',')} FROM "${table.name}" WHERE ${keyWhere(table.key)}`,
      ...keyParams
    );
    if (found) {
      const bootstrapAwardConfig = table.name === 'annual_award_config' &&
        sourceRow.id === 1 && found.id === 1 && found.reward === '';
      if (!valuesMatch(sourceRow, found, table.columns) && !bootstrapAwardConfig) conflicts.push('primary key');
      else if (bootstrapAwardConfig && sourceRow.reward !== found.reward) notPresent++;
      continue;
    }
    notPresent++;
    for (const uniqueKey of table.unique || []) {
      if (uniqueKey.some(column => sourceRow[column] == null)) continue;
      const alternate = await destination.get(
        `SELECT ${table.columns.map(column => `"${column}"`).join(',')} FROM "${table.name}" WHERE ${keyWhere(uniqueKey)}`,
        ...uniqueKey.map(column => sourceRow[column])
      );
      if (alternate) {
        conflicts.push('unique key');
        break;
      }
    }
  }
  if (conflicts.length) throw new MigrationError('Destination contains conflicting records; no source data was overwritten', table.name);
  return notPresent;
}

async function insertRows(rows, table, destination) {
  const columns = table.columns;
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(',');
  const key = table.key.map(column => `"${column}"`).join(',');
  const conflictAction = table.name === 'annual_award_config'
    ? 'DO UPDATE SET reward=EXCLUDED.reward WHERE annual_award_config.reward=\'\''
    : 'DO NOTHING';
  const sql = `INSERT INTO "${table.name}" (${columns.map(column => `"${column}"`).join(',')}) VALUES (${placeholders}) ON CONFLICT (${key}) ${conflictAction}`;
  let inserted = 0;
  for (const row of rows) inserted += (await destination.run(sql, ...columns.map(column => row[column]))).changes;
  return inserted;
}

async function validatePlannedRelationships(plans, destination) {
  const sourceIds = new Map(plans.map(({ table, rows }) => [
    table.name,
    new Set(rows.map(row => row.id).filter(id => id != null))
  ]));
  for (const [childTable, childColumn, parentTable] of RELATIONSHIPS) {
    const childRows = plans.find(plan => plan.table.name === childTable).rows;
    const sourceParentIds = sourceIds.get(parentTable);
    for (const child of childRows) {
      const foreignId = child[childColumn];
      if (foreignId == null || sourceParentIds.has(foreignId)) continue;
      const parent = await destination.get(`SELECT id FROM "${parentTable}" WHERE id=?`, foreignId);
      if (!parent) throw new MigrationError('Source relationship validation failed', childTable);
    }
  }
}

async function validateRelationships(destination) {
  for (const [childTable, childColumn, parentTable] of RELATIONSHIPS) {
    const result = await destination.get(`SELECT COUNT(*)::integer AS count
      FROM "${childTable}" child
      LEFT JOIN "${parentTable}" parent ON parent.id=child."${childColumn}"
      WHERE child."${childColumn}" IS NOT NULL AND parent.id IS NULL`);
    if (result.count !== 0) throw new MigrationError('Destination relationship validation failed', childTable);
  }
}

async function syncSequences(destination) {
  const identityTables = TABLES.filter(table => table.key.length === 1 && table.key[0] === 'id' && table.name !== 'annual_award_config').map(table => table.name);
  for (const table of identityTables) {
    await destination.get(`SELECT setval(pg_get_serial_sequence('"${table}"', 'id'),
      GREATEST(COALESCE(MAX(id), 1), 1), COUNT(*) > 0) FROM "${table}"`);
  }
}

async function migrateSQLiteToPostgres({ sourcePath, destination, dryRun = true, now = Date.now() }) {
  if (!sourcePath) throw new Error('A SQLite backup path is required');
  if (!destination || destination.type !== 'postgres') throw new Error('The migration destination must be PostgreSQL');
  const source = openSQLiteSource(sourcePath);
  try {
    assertKnownTables(source);
    const plans = TABLES.map(table => ({ table, rows: sourceRows(source, table, now) }));
    const run = async () => {
      await validatePlannedRelationships(plans, destination);
      const existingByTable = new Map();
      for (const { table, rows } of plans) existingByTable.set(table.name, await preflightTable(rows, table, destination));
      if (dryRun) {
        await validateRelationships(destination);
        return plans.map(({ table, rows }) => ({
          table: table.name,
          sourceRows: rows.length,
          insertedRows: 0,
          alreadyPresentRows: rows.length - existingByTable.get(table.name)
        }));
      }
      const insertedByTable = new Map();
      for (const { table, rows } of plans) insertedByTable.set(table.name, await insertRows(rows, table, destination));
      for (const { table, rows } of plans) await preflightTable(rows, table, destination);
      await validateRelationships(destination);
      await syncSequences(destination);
      return plans.map(({ table, rows }) => ({
        table: table.name,
        sourceRows: rows.length,
        insertedRows: insertedByTable.get(table.name),
        alreadyPresentRows: rows.length - insertedByTable.get(table.name)
      }));
    };
    return dryRun ? await run() : await destination.transaction(run);
  } finally {
    try {
      source.exec('ROLLBACK');
    } finally {
      source.close();
    }
  }
}

module.exports = { TABLES, MigrationError, assertKnownTables, migrateSQLiteToPostgres, openSQLiteSource, sourceRows, validateRelationships };
