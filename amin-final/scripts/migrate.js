'use strict';

const { createDatabase } = require('../database');

createDatabase().then(async db => {
  console.log(`Database schema is current (${db.type}).`);
  await db.close();
}).catch(error => {
  console.error('Database migration failed:', error);
  process.exitCode = 1;
});
