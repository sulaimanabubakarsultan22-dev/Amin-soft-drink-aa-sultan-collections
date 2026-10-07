'use strict';

const { createDatabase } = require('../database');
const { MigrationError, migrateSQLiteToPostgres } = require('../data-migration');

function parseArgs(args) {
  const options = { dryRun: true, sourcePath: null, help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--source' && args[index + 1]) options.sourcePath = args[++index];
    else if (arg === '--apply') options.dryRun = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error('Invalid migration command options');
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    console.error('Invalid options. Use --help for usage.');
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log('Usage: npm run db:migrate-data -- --source <read-only-sqlite-backup> [--dry-run|--apply]');
    console.log('Default mode is --dry-run. --apply copies into DATABASE_URL and never changes the SQLite source.');
    return;
  }
  if (!options.sourcePath || !process.env.DATABASE_URL) {
    console.error('A SQLite backup path and DATABASE_URL are required. Use --help for usage.');
    process.exitCode = 2;
    return;
  }

  let destination;
  try {
    destination = await createDatabase({ migrate: !options.dryRun });
    if (destination.type !== 'postgres') throw new Error('Migration destination must be PostgreSQL');
    const report = await migrateSQLiteToPostgres({
      sourcePath: options.sourcePath,
      destination,
      dryRun: options.dryRun
    });
    console.log(options.dryRun ? 'Dry run complete; no destination data was changed.' : 'Data migration and validation completed.');
    for (const row of report) {
      console.log(`${row.table}: source=${row.sourceRows}, inserted=${row.insertedRows}, already-present=${row.alreadyPresentRows}`);
    }
  } catch (error) {
    if (error instanceof MigrationError && error.table) {
      console.error(`Migration stopped at table ${error.table}. No source values or credentials were logged.`);
    } else if (error instanceof MigrationError) {
      console.error(`${error.message}. No source values or credentials were logged.`);
    } else {
      const code = /^[0-9A-Z]{5}$/.test(error.code || '') ? ` (database code ${error.code})` : '';
      console.error(`Migration failed${code}. No source values or credentials were logged.`);
    }
    process.exitCode = 1;
  } finally {
    if (destination) await destination.close();
  }
}

main().catch(() => {
  console.error('Migration failed. No source values or credentials were logged.');
  process.exitCode = 1;
});
