'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const TABLES = [
  { name: 'admins', key: ['id'], columns: ['id', 'name', 'email', 'hash', 'role', 'created', 'last_login', 'active'], unique: [['email']] },
  { name: 'categories', key: ['id'], columns: ['id', 'name', 'active'], unique: [['name']] },
  { name: 'customers', key: ['id'], columns: ['id', 'name', 'phone', 'email', 'created'], unique: [['phone']] },
  { name: 'products', key: ['id'], columns: ['id', 'name', 'sku', 'description', 'category', 'product_type', 'price', 'discount', 'stock', 'active', 'image', 'created', 'updated', 'carton_price', 'carton_qty', 'size', 'image_front', 'image_back', 'colors', 'style', 'quality', 'video_url', 'featured', 'best_seller', 'new_arrival', 'flash_deal', 'category_id'], unique: [['sku']] },
  { name: 'sessions', key: ['token_hash'], columns: ['token_hash', 'admin_id', 'expires'] },
  { name: 'orders', key: ['id'], columns: ['id', 'no', 'customer_id', 'address', 'state', 'city', 'notes', 'gps', 'subtotal', 'fee', 'total', 'pay_status', 'status', 'stocked', 'created', 'updated', 'discount', 'coupon_code', 'idem', 'delivery_option'], unique: [['no'], ['idem']] },
  { name: 'order_items', key: ['id'], columns: ['id', 'order_id', 'product_id', 'name', 'qty', 'price', 'pack', 'pack_qty', 'variant'] },
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
  products: { product_type: "CASE WHEN lower(COALESCE(name,'')) LIKE '%thread%' OR lower(COALESCE(name,'')) LIKE '%needle%' OR lower(COALESCE(name,'')) LIKE '%zipper%' OR lower(COALESCE(name,'')) LIKE '%button%' OR lower(COALESCE(name,'')) LIKE '%tape%' OR lower(COALESCE(name,'')) LIKE '%chalk%' OR lower(COALESCE(name,'')) LIKE '%elastic%' OR lower(COALESCE(name,'')) LIKE '%fabric%' OR lower(COALESCE(name,'')) LIKE '%scissor%' OR lower(COALESCE(name,'')) LIKE '%bobbin%' OR lower(COALESCE(name,'')) LIKE '%bead%' OR lower(COALESCE(name,'')) LIKE '%sequin%' OR lower(COALESCE(name,'')) LIKE '%trimming%' THEN 'GOODS' WHEN lower(COALESCE(category,'')) LIKE '%drink%' OR lower(COALESCE(category,'')) LIKE '%juice%' OR lower(COALESCE(category,'')) LIKE '%water%' THEN 'DRINK' WHEN lower(COALESCE(category,'')) LIKE '%cloth%' OR lower(COALESCE(category,'')) LIKE '%fashion%' OR lower(COALESCE(category,'')) LIKE '%apparel%' OR lower(COALESCE(category,'')) LIKE '%wear%' OR lower(COALESCE(category,'')) LIKE '%maza%' OR lower(COALESCE(category,'')) LIKE '%mata%' OR lower(COALESCE(category,'')) LIKE '%yara%' OR lower(COALESCE(category,'')) LIKE '%riguna%' OR lower(COALESCE(category,'')) LIKE '%baby%' OR lower(COALESCE(category,'')) LIKE '%kids%' THEN 'CLOTHING' ELSE 'GOODS' END", style: 'NULL', best_seller: '0', new_arrival: '0', flash_deal: '0' },
  orders: { discount: '0', coupon_code: 'NULL', delivery_option: "'standard'" },
  order_items: { variant: "'{}'" }
};
const IDENTITY_KEYS = {
  admins: [['email']],
  categories: [['name']],
  customers: [['phone']],
  products: [['sku'], ['name', 'category']]
};
const REFERENCES = [
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
  const conflicts = new Set();
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
      if (!valuesMatch(sourceRow, found, table.columns) && !bootstrapAwardConfig) conflicts.add('primary key');
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
        conflicts.add('unique key');
        break;
      }
    }
  }
  if (conflicts.size) {
    const conflictTypes = [...conflicts].join(' and ');
    throw new MigrationError(`Destination contains conflicting ${conflictTypes} records; no source data was overwritten`, table.name);
  }
  return notPresent;
}

async function planIdentityRows(rows, table, destination) {
  const identityKeys = IDENTITY_KEYS[table.name];
  if (!identityKeys) throw new Error(`No stable identity keys are defined for ${table.name}`);
  const mappings = new Map();
  const inserts = [];
  let alreadyPresentRows = 0;
  for (const row of rows) {
    const selectedColumns = [...new Set(['id', ...table.columns])].map(column => `"${column}"`).join(',');
    const byId = await destination.get(`SELECT ${selectedColumns} FROM "${table.name}" WHERE "id" IS NOT DISTINCT FROM ?`, row.id);
    const logicalMatches = [];
    for (const identityKey of identityKeys) {
      if (identityKey.some(column => row[column] == null)) continue;
      const matches = await destination.all(
        `SELECT ${selectedColumns} FROM "${table.name}" WHERE ${keyWhere(identityKey)}`,
        ...identityKey.map(column => row[column])
      );
      for (const match of matches) {
        if (!logicalMatches.some(existing => existing.id === match.id)) logicalMatches.push(match);
      }
    }
    if (logicalMatches.length > 1) {
      throw new MigrationError('Destination contains ambiguous logical identity records; no source data was overwritten', table.name);
    }
    const logicalMatch = logicalMatches[0];
    if (logicalMatch) {
      mappings.set(row.id, logicalMatch.id);
      alreadyPresentRows++;
    } else if (byId && valuesMatch(row, byId, table.columns)) {
      mappings.set(row.id, row.id);
      alreadyPresentRows++;
    } else if (byId) {
      mappings.set(row.id, null);
      inserts.push({ row, remapId: true });
    } else {
      mappings.set(row.id, row.id);
      inserts.push({ row, remapId: false });
    }
  }
  return { mappings, inserts, alreadyPresentRows };
}

async function insertIdentityRows(plan, table, destination, transformRow = row => row) {
  let inserted = 0;
  for (const { row, remapId } of plan.inserts) {
    const valuesRow = transformRow(row);
    const columns = remapId ? table.columns.filter(column => column !== 'id') : table.columns;
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(',');
    const sql = `INSERT INTO "${table.name}" (${columns.map(column => `"${column}"`).join(',')}) VALUES (${placeholders})${remapId ? ' RETURNING id' : ''}`;
    const values = columns.map(column => valuesRow[column]);
    if (remapId) {
      const result = await destination.get(sql, ...values);
      plan.mappings.set(row.id, result.id);
    } else {
      inserted += (await destination.run(sql, ...values)).changes;
    }
    if (remapId) inserted++;
  }
  return inserted;
}

function mapReferences(rows, table, mappings) {
  const references = REFERENCES.filter(([childTable]) => childTable === table.name);
  if (!references.length) return rows;
  return rows.map(row => {
    let mapped = row;
    for (const [, column, parentTable] of references) {
      const sourceId = row[column];
      const parentMappings = mappings.get(parentTable);
      if (sourceId == null || !parentMappings?.has(sourceId)) continue;
      const destinationId = parentMappings.get(sourceId);
      if (destinationId != null) {
        if (mapped === row) mapped = { ...row };
        mapped[column] = destinationId;
      }
    }
    return mapped;
  });
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
      const identityPlans = new Map();
      const mappings = new Map();
      for (const tableName of Object.keys(IDENTITY_KEYS)) {
        const sourcePlan = plans.find(plan => plan.table.name === tableName);
        const identityPlan = await planIdentityRows(sourcePlan.rows, sourcePlan.table, destination);
        identityPlans.set(tableName, identityPlan);
        mappings.set(tableName, identityPlan.mappings);
      }
      const existingByTable = new Map();
      for (const { table, rows } of plans) {
        if (identityPlans.has(table.name)) {
          existingByTable.set(table.name, rows.length - identityPlans.get(table.name).alreadyPresentRows);
          continue;
        }
        const mappedRows = mapReferences(rows, table, mappings);
        existingByTable.set(table.name, await preflightTable(mappedRows, table, destination));
      }
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
      for (const { table, rows } of plans) {
        if (identityPlans.has(table.name)) {
          const inserted = await insertIdentityRows(
            identityPlans.get(table.name),
            table,
            destination,
            row => mapReferences([row], table, mappings)[0]
          );
          insertedByTable.set(table.name, inserted);
          continue;
        }
        insertedByTable.set(table.name, await insertRows(mapReferences(rows, table, mappings), table, destination));
      }
      for (const { table, rows } of plans) {
        if (identityPlans.has(table.name)) {
          for (const [sourceId, destinationId] of identityPlans.get(table.name).mappings) {
            if (destinationId == null || !(await destination.get(`SELECT "id" FROM "${table.name}" WHERE "id"=?`, destinationId))) {
              throw new MigrationError('Destination identity validation failed', table.name);
            }
          }
          continue;
        }
        await preflightTable(mapReferences(rows, table, mappings), table, destination);
      }
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

module.exports = { TABLES, MigrationError, assertKnownTables, insertIdentityRows, mapReferences, migrateSQLiteToPostgres, openSQLiteSource, planIdentityRows, preflightTable, sourceRows, validateRelationships };
