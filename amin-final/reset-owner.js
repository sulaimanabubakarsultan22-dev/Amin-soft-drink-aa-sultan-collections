// Owner-controlled password reset (run on the server). Usage: node --env-file=.env reset-owner.js "NewLongPassword"
const crypto = require('crypto'), { DatabaseSync } = require('node:sqlite');
const pw = process.argv[2] || ''; if (pw.length < 10) { console.error('Password must be at least 10 characters'); process.exit(1); }
const db = new DatabaseSync(process.env.DB_PATH || 'store.db'), s = crypto.randomBytes(16);
const r = db.prepare("UPDATE admins SET hash=?,active=1 WHERE role='owner'").run(s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex'));
db.exec("DELETE FROM sessions WHERE admin_id IN (SELECT id FROM admins WHERE role='owner')");
console.log(r.changes ? 'Owner password reset. All owner sessions were signed out.' : 'No owner account found.');
