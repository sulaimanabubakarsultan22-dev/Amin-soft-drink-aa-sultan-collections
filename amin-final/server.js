'use strict';
// Zero-dependency store backend. Needs Node 22+ (built-in SQLite). Run: node --env-file=.env server.js
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const E = process.env, PORT = +E.PORT || 3000, PSK = E.PAYSTACK_SECRET_KEY || '';
const FEE = +E.DELIVERY_FEE || 2000, PROD = E.NODE_ENV === 'production';
const db = new DatabaseSync(E.DB_PATH || 'store.db');
db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS admins(id INTEGER PRIMARY KEY,name TEXT,email TEXT UNIQUE,hash TEXT,role TEXT,created TEXT,last_login TEXT);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,admin_id INTEGER REFERENCES admins(id),expires INTEGER);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,sku TEXT UNIQUE,description TEXT,category TEXT,price INTEGER NOT NULL CHECK(price>0),discount INTEGER DEFAULT 0 CHECK(discount>=0),stock INTEGER NOT NULL CHECK(stock>=0),active INTEGER DEFAULT 1,image TEXT,created TEXT,updated TEXT,carton_price INTEGER,carton_qty INTEGER,size TEXT,image_front TEXT,image_back TEXT,colors TEXT,quality TEXT,video_url TEXT,featured INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_prod ON products(category,active);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY,name TEXT,phone TEXT UNIQUE,email TEXT,created TEXT);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,no TEXT UNIQUE,customer_id INTEGER REFERENCES customers(id),address TEXT,state TEXT,city TEXT,notes TEXT,gps TEXT,subtotal INTEGER,fee INTEGER,total INTEGER,pay_status TEXT DEFAULT 'pending',status TEXT DEFAULT 'payment_pending',stocked INTEGER DEFAULT 0,created TEXT,updated TEXT);
CREATE INDEX IF NOT EXISTS ix_ord ON orders(pay_status,status,customer_id);
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY,order_id INTEGER REFERENCES orders(id),product_id INTEGER,name TEXT,qty INTEGER,price INTEGER,pack TEXT DEFAULT 'unit',pack_qty INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY,order_id INTEGER REFERENCES orders(id),provider TEXT,reference TEXT UNIQUE,amount INTEGER,currency TEXT,status TEXT,response TEXT,created TEXT,verified TEXT);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT);
CREATE TABLE IF NOT EXISTS order_events(id INTEGER PRIMARY KEY,order_id INTEGER REFERENCES orders(id),label TEXT,at TEXT);`);
try { db.exec('ALTER TABLE orders ADD COLUMN idem TEXT'); } catch {}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_idem ON orders(idem)');
try { db.exec('ALTER TABLE admins ADD COLUMN active INTEGER DEFAULT 1'); } catch {}
try { db.exec('ALTER TABLE products ADD COLUMN carton_price INTEGER'); } catch {}
try { db.exec('ALTER TABLE products ADD COLUMN carton_qty INTEGER'); } catch {}
try { db.exec('ALTER TABLE products ADD COLUMN size TEXT'); } catch {}
try { db.exec('ALTER TABLE products ADD COLUMN image_front TEXT'); } catch {}
try { db.exec('ALTER TABLE products ADD COLUMN image_back TEXT'); } catch {}
try { db.exec('ALTER TABLE products ADD COLUMN colors TEXT'); } catch {}
try { db.exec('ALTER TABLE products ADD COLUMN quality TEXT'); } catch {}
try { db.exec('ALTER TABLE products ADD COLUMN video_url TEXT'); } catch {}
try { db.exec('ALTER TABLE products ADD COLUMN featured INTEGER DEFAULT 0'); } catch {}
try { db.exec("ALTER TABLE order_items ADD COLUMN pack TEXT DEFAULT 'unit'"); } catch {}
try { db.exec('ALTER TABLE order_items ADD COLUMN pack_qty INTEGER DEFAULT 1'); } catch {}

const now = () => new Date().toISOString();
class Err extends Error { constructor(c, m) { super(m); this.c = c; } }
const hashPw = p => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(p, s, 64).toString('hex'); };
const checkPw = (p, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(crypto.scryptSync(p, Buffer.from(s, 'hex'), 64), Buffer.from(k, 'hex')); };
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
if (!db.prepare('SELECT 1 FROM admins').get() && E.ADMIN_EMAIL && (E.ADMIN_PASSWORD || '').length >= 10)
  db.prepare('INSERT INTO admins(name,email,hash,role,created) VALUES(?,?,?,?,?)').run('Owner', E.ADMIN_EMAIL.toLowerCase(), hashPw(E.ADMIN_PASSWORD), 'owner', now());

const hits = new Map();
const ipOf = req => (E.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
const limited = (k, max, win) => { const t = Date.now(), a = (hits.get(k) || []).filter(x => t - x < win); hits.set(k, a); return a.length >= max; };
const hit = k => { if (!hits.has(k)) hits.set(k, []); hits.get(k).push(Date.now()); };
const ph = p => { const m = /^(?:234|0)([789][01]\d{8})$/.exec(String(p || '').replace(/[\s\-+]/g, '')); return m ? '0' + m[1] : null; };
const str = (v, min, max, f) => { v = String(v ?? '').trim(); if (v.length < min || v.length > max) throw new Err(400, `${f} is invalid`); return v; };
const int = (v, min, max, f) => { v = Number(v); if (!Number.isInteger(v) || v < min || v > max) throw new Err(400, `${f} is invalid`); return v; };
const DEF = { name: 'AMIN SOFT DRINK & A.A SULTAN COLLECTIONS', tag: 'Abubuwan sha da kayan masarufi iri-iri • Yi oda online • A biya online • A kawo maka har inda kake', wa: '2348163827505', phone: '08163827505', email: '', address: '', cur: '₦', fee: String(FEE), fb: '', ig: '', x: '', tt: '', hours: '', returns: '' };
const settings = () => { const o = { ...DEF }; for (const r of db.prepare('SELECT k,v FROM settings').all()) if (r.k in DEF) o[r.k] = r.v; return o; };
// Notification hook: wire email/SMS/WhatsApp providers here. Nothing is sent until you do.
const notify = (event, data) => {};
const ev = (oid, label) => db.prepare('INSERT INTO order_events(order_id,label,at) VALUES(?,?,?)').run(oid, label, now());
const eff = p => (p.discount > 0 && p.discount < p.price ? p.discount : p.price);

function adminOf(req, roles) {
  const m = /(?:^|; )sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  const a = m && db.prepare('SELECT a.* FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE token_hash=? AND expires>? AND a.active=1').get(sha(m[1]), Date.now());
  if (!a) throw new Err(401, 'Login required');
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'store') throw new Err(403, 'Forbidden');
  if (roles && !roles.includes(a.role)) throw new Err(403, 'Not allowed for your role');
  return a;
}
const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

function createOrder(b, idem) {
  const c = b.customer || {}, phone = ph(c.phone);
  if (!phone) throw new Err(400, 'Enter a valid Nigerian phone number');
  const name = str(c.name, 3, 100, 'Name'), email = c.email ? str(c.email, 5, 120, 'Email') : null;
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Err(400, 'Email is invalid');
  const addr = str(b.address, 6, 300, 'Address'), state = str(b.state, 2, 60, 'State'), city = str(b.city, 2, 60, 'City');
  const notes = String(b.notes || '').slice(0, 300), gps = /^-?\d+\.\d+,-?\d+\.\d+$/.test(b.gps || '') ? b.gps : null;
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) throw new Err(400, 'Cart is empty');
  return tx(() => {
    if (idem) { const x = db.prepare('SELECT no,total FROM orders WHERE idem=?').get(idem); if (x) return x; }
    let sub = 0; const lines = []; const fee = Math.max(0, parseInt(settings().fee) || 0);
    for (const it of b.items) {
      const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1 AND ' + CV).get(int(it.id, 1, 1e9, 'Product'));
      const q = int(it.qty, 1, 99, 'Quantity');
      const pack = it.pack === 'carton' ? 'carton' : 'unit';
      const packQty = pack === 'carton' ? int(p?.carton_qty, 1, 1000, 'Carton quantity') : 1;
      const unitPrice = pack === 'carton' ? int(p?.carton_price, 1, 1e9, 'Carton price') : eff(p || {});
      if (!p) throw new Err(409, 'A product is no longer available');
      const needed = q * packQty;
      if (p.stock < needed) throw new Err(409, `${p.name}: only ${p.stock} unit(s) left`);
      sub += unitPrice * q; lines.push([p, q, pack, packQty, unitPrice]);
    }
    const cid = db.prepare(`INSERT INTO customers(name,phone,email,created) VALUES(?,?,?,?) ON CONFLICT(phone) DO UPDATE SET name=excluded.name,email=COALESCE(excluded.email,email) RETURNING id`).get(name, phone, email, now()).id;
    const no = 'ORD-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const oid = db.prepare('INSERT INTO orders(no,customer_id,address,state,city,notes,gps,subtotal,fee,total,idem,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id').get(no, cid, addr, state, city, notes, gps, sub, fee, sub + fee, idem || null, now(), now()).id;
    ev(oid, 'Order placed'); notify('order.created', { no });
    for (const [p, q, pack, packQty, price] of lines) db.prepare('INSERT INTO order_items(order_id,product_id,name,qty,price,pack,pack_qty) VALUES(?,?,?,?,?,?,?)').run(oid, p.id, p.name, q, price, pack, packQty);
    return { no, total: sub + fee };
  });
}

// Idempotent settlement. Only called with data that came from Paystack's verify API or a signed webhook.
function settle(ref, d) {
  return tx(() => {
    const p = db.prepare('SELECT * FROM payments WHERE reference=?').get(ref);
    if (!p) throw new Err(404, 'Unknown reference');
    if (p.status === 'paid' || p.status === 'refund_due') return p.status;
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(p.order_id);
    const upd = s => db.prepare('UPDATE payments SET status=?,response=?,verified=? WHERE id=?').run(s, JSON.stringify(d).slice(0, 4000), now(), p.id);
    if (d.status !== 'success') { const s = d.status === 'abandoned' ? 'cancelled' : d.status === 'failed' ? 'failed' : 'processing'; upd(s); return s; }
    if (d.amount !== o.total * 100 || d.currency !== 'NGN' || d.reference !== ref) { upd('failed'); return 'failed'; }
    // A second successful payment, or one for a closed order, must never touch stock or the order: flag it for refund.
    if (o.pay_status === 'paid' || ['cancelled', 'refunded'].includes(o.status)) { upd('refund_due'); ev(o.id, 'Extra payment received on a closed or already-paid order: refund needed'); notify('payment.refund_due', { no: o.no }); return 'refund_due'; }
    upd('paid'); ev(o.id, 'Payment confirmed'); notify('payment.paid', { no: o.no });
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);
    const short = items.some(i => (db.prepare('SELECT stock FROM products WHERE id=?').get(i.product_id)?.stock ?? 0) < i.qty * (i.pack_qty || 1));
    if (!short) for (const i of items) db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(i.qty * (i.pack_qty || 1), i.product_id);
    // Money received but stock gone => needs_review (refund or restock); never silently oversell.
    db.prepare('UPDATE orders SET pay_status=?,status=?,stocked=?,updated=? WHERE id=?').run('paid', short ? 'needs_review' : 'paid', short ? 0 : 1, now(), o.id);
    return 'paid';
  });
}

const NEXT = { payment_pending: ['cancelled'], paid: ['processing', 'cancelled', 'refunded'], processing: ['ready_for_delivery', 'cancelled', 'refunded'], ready_for_delivery: ['shipped', 'cancelled', 'refunded'], shipped: ['delivered', 'refunded'], delivered: ['refunded'], needs_review: ['processing', 'refunded', 'cancelled'] };
function setStatus(no, to) {
  return tx(() => {
    const o = db.prepare('SELECT * FROM orders WHERE no=?').get(no);
    if (!o) throw new Err(404, 'Order not found');
    if (!(NEXT[o.status] || []).includes(to)) throw new Err(409, `Cannot change ${o.status} to ${to}`);
    if (['cancelled', 'refunded'].includes(to) && o.stocked) {
      for (const i of db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id)) db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(i.qty * (i.pack_qty || 1), i.product_id);
    }
    db.prepare('UPDATE orders SET status=?,stocked=?,pay_status=?,updated=? WHERE id=?').run(to, ['cancelled', 'refunded'].includes(to) ? 0 : o.stocked, to === 'refunded' ? 'refunded' : o.pay_status, now(), o.id);
    ev(o.id, 'Status: ' + to.replace(/_/g, ' ')); notify('order.status', { no, status: to });
    return { no, status: to };
  });
}

const IMGURL = "CASE WHEN image IS NULL THEN NULL ELSE '/img/'||id||'?v='||replace(replace(updated,':',''),'.','') END";
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const X = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HDR = { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', 'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' https:; frame-ancestors 'none'", ...(PROD ? { 'strict-transport-security': 'max-age=31536000' } : {}) };
function backup() { if (!E.BACKUP_DIR) return; fs.mkdirSync(E.BACKUP_DIR, { recursive: true }); const f = path.join(E.BACKUP_DIR, 'store-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db'); db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`); for (const x of fs.readdirSync(E.BACKUP_DIR).filter(x => /^store-.*\.db$/.test(x)).sort().slice(0, -14)) fs.unlinkSync(path.join(E.BACKUP_DIR, x)); return f; }
db.exec('CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,active INTEGER DEFAULT 1)');
db.exec(`CREATE TABLE IF NOT EXISTS videos(id INTEGER PRIMARY KEY,title TEXT NOT NULL,description TEXT,product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,url TEXT NOT NULL,staff_id INTEGER REFERENCES admins(id),active INTEGER DEFAULT 1,created TEXT,updated TEXT); CREATE INDEX IF NOT EXISTS ix_videos ON videos(active,created);`);
try { db.exec('ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES categories(id)'); } catch {}
db.exec('CREATE INDEX IF NOT EXISTS ix_pcat ON products(category_id)');
for (const r of db.prepare("SELECT DISTINCT category c FROM products WHERE category<>'' AND category_id IS NULL").all()) { db.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)').run(r.c); db.prepare('UPDATE products SET category_id=(SELECT id FROM categories WHERE name=?) WHERE category=? AND category_id IS NULL').run(r.c, r.c); }
const CV = '(category_id IS NULL OR category_id IN (SELECT id FROM categories WHERE active=1))';
const IMG = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
function prodFields(b) {
  const price = int(b.price, 1, 1e9, 'Unit price'), discount = b.discount ? int(b.discount, 0, 1e9, 'Discount') : 0;
  const carton_price = b.carton_price === '' || b.carton_price == null ? null : int(b.carton_price, 1, 1e9, 'Carton price');
  const carton_qty = b.carton_qty === '' || b.carton_qty == null ? null : int(b.carton_qty, 1, 1000, 'Carton quantity');
  const size = b.size ? String(b.size).trim().slice(0, 120) : null;
  const colors = b.colors ? String(b.colors).trim().slice(0, 300) : null;
  const quality = b.quality ? String(b.quality).trim().slice(0, 500) : null;
  const video_url = b.video_url ? String(b.video_url).trim().slice(0, 500) : null;
  const featured = b.featured ? 1 : 0;
  if (discount >= price && discount) throw new Err(400, 'Discount must be lower than price');
  const validMedia = v => { if (!v) return true; const m = IMG.exec(v), buf = m && Buffer.from(v.slice(v.indexOf(',') + 1), 'base64'); const ok = buf && buf.length <= 700e3 && ((m[1] === 'jpeg' && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) || (m[1] === 'png' && buf.subarray(0, 4).equals(Buffer.from([0x89,0x50,0x4e,0x47]))) || (m[1] === 'webp' && buf.subarray(0,4).toString()==='RIFF' && buf.subarray(8,12).toString()==='WEBP')); return !!ok; };
  if (b.image) { const m = IMG.exec(b.image), buf = m && Buffer.from(b.image.slice(b.image.indexOf(',') + 1), 'base64');
    const ok = buf && buf.length <= 700e3 && ((m[1] === 'jpeg' && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) || (m[1] === 'png' && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) || (m[1] === 'webp' && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP'));
    if (!ok) throw new Err(400, 'Image must be a real JPG, PNG or WebP under 700KB'); }
  if (b.image_front && !validMedia(b.image_front)) throw new Err(400, 'Front image must be a real JPG, PNG or WebP under 700KB');
  if (b.image_back && !validMedia(b.image_back)) throw new Err(400, 'Back image must be a real JPG, PNG or WebP under 700KB');
  if (video_url && !/^https?:\/\//i.test(video_url)) throw new Err(400, 'Video URL must start with https://');
  let cid = null, cname = '';
  if (b.category_id) { cid = int(b.category_id, 1, 1e9, 'Category'); const c = db.prepare('SELECT name FROM categories WHERE id=?').get(cid); if (!c) throw new Err(400, 'Category does not exist'); cname = c.name; }
  return [str(b.name, 2, 150, 'Name'), b.sku ? str(b.sku, 1, 50, 'SKU') : null, String(b.description || '').slice(0, 3000), cname, price, discount, int(b.stock, 0, 1e6, 'Stock'), b.active === false ? 0 : 1, b.image || null, cid, carton_price, carton_qty, size, b.image_front || null, b.image_back || null, colors, quality, video_url, featured];
}
const orderView = o => ({ ...o, items: db.prepare('SELECT name,qty,price,pack,pack_qty FROM order_items WHERE order_id=?').all(o.id), payments: db.prepare('SELECT reference,provider,amount,currency,status,created,verified FROM payments WHERE order_id=? ORDER BY id').all(o.id), events: db.prepare('SELECT label,at FROM order_events WHERE order_id=? ORDER BY id').all(o.id) });

async function route(req, res, url, raw) {
  const m = req.method, p = url.pathname, q = url.searchParams, body = () => { try { return JSON.parse(raw.toString() || '{}'); } catch { throw new Err(400, 'Invalid JSON'); } };
  let r;
  if (m === 'GET' && p === '/api/settings') return settings();
  if ((r = /^\/api\/products\/(\d+)$/.exec(p)) && m === 'GET') { const x = db.prepare(`SELECT id,name,sku,description,category,price,discount,carton_price,carton_qty,size,stock,colors,quality,video_url,featured,${IMGURL} AS image,CASE WHEN image_front IS NULL THEN NULL ELSE '/imgfront/'||id||'?v='||replace(replace(updated,':',''),'.','') END AS image_front,CASE WHEN image_back IS NULL THEN NULL ELSE '/imgback/'||id||'?v='||replace(replace(updated,':',''),'.','') END AS image_back FROM products WHERE id=? AND active=1 AND ${CV}`).get(+r[1]); if (!x) throw new Err(404, 'Product not found'); return x; }
  if (m === 'GET' && p === '/api/products') {
    const pg = Math.max(1, +q.get('page') || 1), s = '%' + (q.get('q') || '').replace(/[%_]/g, '') + '%', cat = +q.get('cat') || 0;
    const w = 'active=1 AND ' + CV + " AND (name LIKE ? OR category LIKE ? OR sku LIKE ?) AND (?=0 OR category_id=?) AND (?=0 OR stock>0)";
    const a = [s, s, s, cat, cat, q.get('instock') === '1' ? 1 : 0];
    return { items: db.prepare(`SELECT id,name,sku,description,category,price,discount,carton_price,carton_qty,size,colors,quality,video_url,featured,stock,${IMGURL} AS image,CASE WHEN image_front IS NULL THEN NULL ELSE '/imgfront/'||id||'?v='||replace(replace(updated,':',''),'.','') END AS image_front,CASE WHEN image_back IS NULL THEN NULL ELSE '/imgback/'||id||'?v='||replace(replace(updated,':',''),'.','') END AS image_back FROM products WHERE ${w} ORDER BY id DESC LIMIT 24 OFFSET ?`).all(...a, (pg - 1) * 24), total: db.prepare(`SELECT COUNT(*) n FROM products WHERE ${w}`).get(...a).n, page: pg, cats: db.prepare('SELECT id,name FROM categories WHERE active=1 ORDER BY name').all() };
  }
  if (m === 'GET' && p === '/api/featured') return {items: db.prepare(`SELECT id,name,description,category,price,discount,carton_price,carton_qty,size,colors,quality,video_url,featured,stock,${IMGURL} AS image,CASE WHEN image_front IS NULL THEN NULL ELSE '/imgfront/'||id||'?v='||replace(replace(updated,':',''),'.','') END AS image_front,CASE WHEN image_back IS NULL THEN NULL ELSE '/imgback/'||id||'?v='||replace(replace(updated,':',''),'.','') END AS image_back FROM products WHERE active=1 AND featured=1 AND ` + CV + ` ORDER BY id DESC LIMIT 12`).all()};
  if (m === 'GET' && p === '/api/videos') { const pid = +q.get('product') || 0; return { items: db.prepare(`SELECT v.id,v.title,v.description,v.product_id,v.url,v.created,p.name product_name FROM videos v LEFT JOIN products p ON p.id=v.product_id WHERE v.active=1 AND (?=0 OR v.product_id=?) ORDER BY v.id DESC LIMIT 50`).all(pid,pid) }; }
  if (m === 'POST' && p === '/api/orders') { if (limited('o' + ipOf(req), 20, 36e5)) throw new Err(429, 'Too many orders, try later'); hit('o' + ipOf(req)); return createOrder(body(), String(req.headers['idempotency-key'] || '').slice(0, 64) || null); }
  if ((r = /^\/api\/orders\/(ORD-[A-F0-9]+)\/pay$/.exec(p)) && m === 'POST') {
    if (!PSK) throw new Err(503, 'Online payment is not configured yet');
    if (limited('p' + ipOf(req), 20, 36e5)) throw new Err(429, 'Too many payment attempts, try later'); hit('p' + ipOf(req));
    const o = db.prepare('SELECT o.*,c.email,c.phone FROM orders o JOIN customers c ON c.id=o.customer_id WHERE no=?').get(r[1]);
    if (!o || o.pay_status === 'paid' || o.status === 'cancelled') throw new Err(409, 'Order not payable');
    const ref = o.no + '-' + crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO payments(order_id,provider,reference,amount,currency,status,created) VALUES(?,?,?,?,?,?,?)').run(o.id, 'paystack', ref, o.total, 'NGN', 'pending', now());
    const fl = () => db.prepare("UPDATE payments SET status='failed' WHERE reference=?").run(ref);
    let j; try { j = await (await fetch('https://api.paystack.co/transaction/initialize', { method: 'POST', headers: { authorization: 'Bearer ' + PSK, 'content-type': 'application/json' }, body: JSON.stringify({ email: o.email || `${o.phone}@${E.NOEMAIL_DOMAIN || 'example.com'}`, amount: o.total * 100, currency: 'NGN', reference: ref, callback_url: E.PUBLIC_URL + '/?no=' + o.no }) })).json(); } catch { fl(); throw new Err(502, 'Payment provider unreachable'); }
    if (!j.status) { fl(); throw new Err(502, 'Could not start payment'); }
    return { url: j.data.authorization_url, reference: ref };
  }
  if (m === 'GET' && p === '/api/pay/verify') {
    if (!PSK) throw new Err(503, 'Online payment is not configured yet');
    if (limited('v' + ipOf(req), 60, 36e5)) throw new Err(429, 'Too many requests, try later'); hit('v' + ipOf(req));
    const ref = str(q.get('reference'), 5, 80, 'Reference');
    let j; try { j = await (await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(ref), { headers: { authorization: 'Bearer ' + PSK } })).json(); } catch { throw new Err(502, 'Payment provider unreachable'); }
    if (!j.status) throw new Err(502, 'Could not verify payment');
    return { payment_status: settle(ref, j.data) };
  }
  if (m === 'POST' && p === '/api/webhook/paystack') {
    const sig = String(req.headers['x-paystack-signature'] || '');
    const exp = crypto.createHmac('sha512', PSK || 'x').update(raw).digest('hex');
    if (!PSK || sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) throw new Err(401, 'Bad signature');
    const ev = body(); if (ev.event === 'charge.success' && ev.data?.reference) try { settle(ev.data.reference, ev.data); } catch (e) { if (e.c !== 404) throw e; }
    return { ok: true };
  }
  if (m === 'POST' && p === '/api/track') {
    if (limited('t' + ipOf(req), 15, 6e5)) throw new Err(429, 'Too many attempts');
    hit('t' + ipOf(req)); const b = body();
    const o = db.prepare('SELECT o.*,c.name cname FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.no=? AND c.phone=?').get(String(b.no || '').toUpperCase(), ph(b.phone));
    if (!o) throw new Err(404, 'No order found for that number and phone');
    const v = orderView(o); v.customer = v.cname; delete v.cname; delete v.idem; delete v.id; delete v.customer_id; delete v.stocked; v.payments = v.payments.map(x => ({ status: x.status, amount: x.amount })); return v;
  }
  if (m === 'POST' && p === '/api/admin/login') {
    const ip = 'l' + ipOf(req); if (limited(ip, 5, 9e5)) throw new Err(429, 'Too many failed logins. Wait 15 minutes.');
    const b = body(), a = db.prepare('SELECT * FROM admins WHERE email=?').get(String(b.email || '').toLowerCase());
    let ok = false; try { ok = a && a.active !== 0 && checkPw(String(b.password || ''), a.hash); } catch {}
    if (!ok) { hit(ip); throw new Err(401, 'Incorrect email or password'); }
    const t = crypto.randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(t), a.id, Date.now() + 864e5); db.prepare('UPDATE admins SET last_login=? WHERE id=?').run(now(), a.id);
    return { _h: { 'set-cookie': `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${PROD ? '; Secure' : ''}` }, name: a.name, role: a.role };
  }
  if (p.startsWith('/api/admin/')) {
    const a = adminOf(req), P = p.slice(11);
    if (m === 'POST' && P === 'logout') { db.prepare('DELETE FROM sessions WHERE admin_id=?').run(a.id); return { _h: { 'set-cookie': 'sid=; Max-Age=0; Path=/' }, ok: true }; }
    if (m === 'GET' && P === 'me') return { name: a.name, role: a.role };
    if (m === 'POST' && P === 'password') { const b = body(); let ok = false; try { ok = checkPw(String(b.current || ''), a.hash); } catch {} if (!ok) throw new Err(403, 'Current password is incorrect'); const n = String(b.new || ''); if (n.length < 10) throw new Err(400, 'New password must be at least 10 characters'); db.prepare('UPDATE admins SET hash=? WHERE id=?').run(hashPw(n), a.id); return { ok: true }; }
    if (P === 'staff' || P.startsWith('staff/')) {
      adminOf(req, ['owner']);
      if (m === 'GET' && P === 'staff') return db.prepare('SELECT id,name,email,role,active,created,last_login FROM admins ORDER BY id').all();
      if (m === 'POST' && P === 'staff') { const b = body(), role = ['admin', 'staff', 'customer_care'].includes(b.role) ? b.role : null; if (!role) throw new Err(400, 'Role must be admin or staff'); const em = str(b.email, 5, 120, 'Email').toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(em)) throw new Err(400, 'Email is invalid'); if (String(b.password || '').length < 10) throw new Err(400, 'Password must be at least 10 characters'); try { return { id: db.prepare('INSERT INTO admins(name,email,hash,role,created,active) VALUES(?,?,?,?,?,1) RETURNING id').get(str(b.name, 2, 80, 'Name'), em, hashPw(String(b.password)), role, now()).id }; } catch (e) { if (/UNIQUE/.test(e.message)) throw new Err(409, 'That email already has an account'); throw e; } }
      const rr = /^staff\/(\d+)(\/reset)?$/.exec(P);
      if (rr) { const t = db.prepare('SELECT * FROM admins WHERE id=?').get(+rr[1]); if (!t) throw new Err(404, 'Not found'); if (t.role === 'owner') throw new Err(403, 'The owner account cannot be changed here');
        if (m === 'POST' && rr[2]) { const tmp = crypto.randomBytes(9).toString('base64url'); db.prepare('UPDATE admins SET hash=? WHERE id=?').run(hashPw(tmp), t.id); db.prepare('DELETE FROM sessions WHERE admin_id=?').run(t.id); return { temp_password: tmp }; }
        if (m === 'PATCH') { const b = body(); if ('role' in b) { if (!['admin', 'staff', 'customer_care'].includes(b.role)) throw new Err(400, 'Invalid team role'); db.prepare('UPDATE admins SET role=? WHERE id=?').run(b.role, t.id); } if ('active' in b) { db.prepare('UPDATE admins SET active=? WHERE id=?').run(b.active ? 1 : 0, t.id); if (!b.active) db.prepare('DELETE FROM sessions WHERE admin_id=?').run(t.id); } return { ok: true }; } }
    }
    if (m === 'GET' && P === 'products') { adminOf(req, ['owner','admin']); const pg = Math.max(1, +q.get('page') || 1); return { items: db.prepare(`SELECT id,name,sku,description,category,category_id,price,discount,carton_price,carton_qty,size,colors,quality,video_url,featured,stock,active,${IMGURL} AS image,CASE WHEN image_front IS NULL THEN NULL ELSE '/imgfront/'||id||'?v='||replace(replace(updated,':',''),'.','') END AS image_front,CASE WHEN image_back IS NULL THEN NULL ELSE '/imgback/'||id||'?v='||replace(replace(updated,':',''),'.','') END AS image_back FROM products ORDER BY id DESC LIMIT 25 OFFSET ?`).all((pg - 1) * 25), total: db.prepare('SELECT COUNT(*) n FROM products').get().n, page: pg }; }
    if (m === 'PUT' && P === 'settings') { adminOf(req, ['owner', 'admin']); const b = body(), up = db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'); for (const k of Object.keys(DEF)) if (k in b) { let v = String(b[k] ?? '').trim().slice(0, 600); if (k === 'fee') v = String(int(v, 0, 1e6, 'Delivery fee')); if (['fb', 'ig', 'x', 'tt'].includes(k) && v && !/^https?:\/\//.test(v)) throw new Err(400, 'Social links must start with https://'); if (k === 'wa') v = v.replace(/\D/g, ''); up.run(k, v); } return settings(); }
    if ((r = /^customers\/(\d+)\/orders$/.exec(P)) && m === 'GET') { adminOf(req, ['owner','admin','customer_care']); return db.prepare('SELECT o.*,c.name customer,c.phone FROM orders o JOIN customers c ON c.id=o.customer_id WHERE c.id=? ORDER BY o.id DESC').all(+r[1]).map(orderView); }
    if (m === 'GET' && P === 'dashboard') { adminOf(req, ['owner','admin']);
      const g = (w, ...x) => db.prepare(w).get(...x);
      const s = d => g("SELECT COALESCE(SUM(total),0) n FROM orders WHERE pay_status='paid' AND created>=?", d).n, day = new Date(); day.setHours(0, 0, 0, 0);
      return { sales_total: s('0'), sales_today: s(day.toISOString()), sales_week: s(new Date(Date.now() - 6048e5).toISOString()), sales_month: s(new Date(Date.now() - 2592e6).toISOString()), paid: g("SELECT COUNT(*) n FROM orders WHERE pay_status='paid'").n, pending: g("SELECT COUNT(*) n FROM orders WHERE status='payment_pending'").n, delivered: g("SELECT COUNT(*) n FROM orders WHERE status='delivered'").n, cancelled: g("SELECT COUNT(*) n FROM orders WHERE status='cancelled'").n, needs_review: g("SELECT COUNT(*) n FROM orders WHERE status='needs_review'").n, customers: g('SELECT COUNT(*) n FROM customers').n, products: g('SELECT COUNT(*) n FROM products').n, low_stock: g('SELECT COUNT(*) n FROM products WHERE stock<=5').n };
    }
    if (m === 'GET' && P === 'orders') { adminOf(req, ['owner','admin','staff','customer_care']);
      const s = '%' + (q.get('q') || '') + '%';
      return db.prepare(`SELECT o.*,c.name customer,c.phone FROM orders o JOIN customers c ON c.id=o.customer_id WHERE (o.no LIKE ? OR c.phone LIKE ? OR c.name LIKE ?) AND (?='' OR o.pay_status=?) AND (?='' OR o.status=?) ORDER BY o.id DESC LIMIT 100`).all(s, s, s, q.get('pay') || '', q.get('pay') || '', q.get('status') || '', q.get('status') || '').map(orderView);
    }
    if ((r = /^orders\/(ORD-[A-F0-9]+)$/.exec(P)) && m === 'PATCH') { adminOf(req, ['owner', 'admin', 'staff']); return setStatus(r[1], String(body().status)); }
    if (m === 'GET' && P === 'customers') { adminOf(req, ['owner','admin','customer_care']); return db.prepare(`SELECT c.id,c.name,c.phone,c.email,COUNT(o.id) orders,COALESCE(SUM(CASE WHEN o.pay_status='paid' THEN o.total END),0) spent,MAX(o.created) last_order FROM customers c LEFT JOIN orders o ON o.customer_id=c.id GROUP BY c.id ORDER BY last_order DESC LIMIT 200`).all(); }
    if (m === 'GET' && P === 'payments') { adminOf(req, ['owner','admin']); return db.prepare('SELECT p.reference,p.provider,p.amount,p.currency,p.status,p.created,p.verified,o.no order_no,c.name customer FROM payments p JOIN orders o ON o.id=p.order_id JOIN customers c ON c.id=o.customer_id ORDER BY p.id DESC LIMIT 200').all(); }
    if (P === 'videos' || P.startsWith('videos/')) {
      if (m === 'GET' && P === 'videos') { adminOf(req, ['owner','admin','staff']); const mine = a.role === 'staff' ? ' AND v.staff_id=' + a.id : ''; return db.prepare(`SELECT v.id,v.title,v.description,v.product_id,v.url,v.active,v.created,v.updated,v.staff_id,p.name product_name FROM videos v LEFT JOIN products p ON p.id=v.product_id WHERE 1=1${mine} ORDER BY v.id DESC LIMIT 100`).all(); }
      if (m === 'POST' && P === 'videos') {
        adminOf(req, ['owner','admin','staff']); const b=body(); const title=str(b.title,2,150,'Title'), description=String(b.description||'').slice(0,1000); let pid=b.product_id?int(b.product_id,1,1e9,'Product'):null;
        if (pid && !db.prepare('SELECT 1 FROM products WHERE id=?').get(pid)) throw new Err(400,'Product does not exist');
        let url=String(b.video_url||'').trim();
        if (b.video_data) {
          const m2=/^data:video\/(mp4|webm|ogg);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.video_data)); if(!m2) throw new Err(400,'Video must be MP4, WebM or OGG');
          const buf=Buffer.from(m2[2],'base64'); if(buf.length<1000 || buf.length>10e6) throw new Err(400,'Video must be between 1KB and 10MB');
          const dir=path.join(__dirname,'public','uploads','videos'); fs.mkdirSync(dir,{recursive:true}); const fn='video-'+crypto.randomBytes(10).toString('hex')+'.'+m2[1]; fs.writeFileSync(path.join(dir,fn),buf); url='/uploads/videos/'+fn;
        } else if(!/^https:\/\//i.test(url)) throw new Err(400,'Upload a video or provide an https:// video URL');
        return {id:db.prepare('INSERT INTO videos(title,description,product_id,url,staff_id,active,created,updated) VALUES(?,?,?,?,?,1,?,?) RETURNING id').get(title,description,pid,url,a.id,now(),now()).id};
      }
      const vr=/^videos\/(\d+)$/.exec(P); if(vr && (m==='DELETE'||m==='PATCH')) { const v=db.prepare('SELECT * FROM videos WHERE id=?').get(+vr[1]); if(!v) throw new Err(404,'Video not found'); if(a.role==='staff' && v.staff_id!==a.id) throw new Err(403,'You can only manage your own videos'); if(m==='DELETE'){db.prepare('UPDATE videos SET active=0,updated=? WHERE id=?').run(now(),v.id);return {ok:true}} const b=body(); db.prepare('UPDATE videos SET active=?,updated=? WHERE id=?').run(b.active?1:0,now(),v.id); return {ok:true}; }
    }
    if (P === 'categories' || P.startsWith('categories/')) {
      if (m === 'GET' && P === 'categories') return db.prepare('SELECT c.*,(SELECT COUNT(*) FROM products WHERE category_id=c.id) products FROM categories c ORDER BY name').all();
      adminOf(req, ['owner', 'admin']);
      const dup = e => { if (/UNIQUE/.test(e.message)) throw new Err(409, 'Category already exists'); throw e; };
      if (m === 'POST' && P === 'categories') { try { return { id: db.prepare('INSERT INTO categories(name) VALUES(?) RETURNING id').get(str(body().name, 2, 60, 'Name')).id }; } catch (e) { dup(e); } }
      if ((r = /^categories\/(\d+)$/.exec(P))) {
        const id = +r[1];
        if (m === 'PATCH') { const b = body(); if (b.name !== undefined) { const nm = str(b.name, 2, 60, 'Name'); try { db.prepare('UPDATE categories SET name=? WHERE id=?').run(nm, id); } catch (e) { dup(e); } db.prepare('UPDATE products SET category=? WHERE category_id=?').run(nm, id); } if (b.active !== undefined) db.prepare('UPDATE categories SET active=? WHERE id=?').run(b.active ? 1 : 0, id); return { ok: true }; }
        if (m === 'DELETE') {
          const n = db.prepare('SELECT COUNT(*) n FROM products WHERE category_id=?').get(id).n, to = q.get('reassign');
          if (n) { if (!to) throw new Err(409, `${n} product(s) use this category. Move them to another category first.`); const t = int(to, 1, 1e9, 'Category'), tc = db.prepare('SELECT name FROM categories WHERE id=?').get(t); if (t === id || !tc) throw new Err(400, 'Invalid target category'); db.prepare('UPDATE products SET category_id=?,category=? WHERE category_id=?').run(t, tc.name, id); }
          db.prepare('DELETE FROM categories WHERE id=?').run(id); return { ok: true };
        }
      }
    }
    if (m === 'POST' && P === 'products') { adminOf(req, ['owner', 'admin']); try { const f = prodFields(body()); return { id: db.prepare('INSERT INTO products(name,sku,description,category,price,discount,stock,active,image,category_id,carton_price,carton_qty,size,image_front,image_back,colors,quality,video_url,featured,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id').get(...f, now(), now()).id }; } catch (e) { if (/UNIQUE/.test(e.message)) throw new Err(409, 'SKU already exists'); throw e; } }
    if ((r = /^products\/(\d+)$/.exec(P))) {
      adminOf(req, ['owner', 'admin']);
      if (m === 'PUT') { const b = body(); const oldp=db.prepare('SELECT image,image_front,image_back FROM products WHERE id=?').get(+r[1]); if (String(b.image || '').startsWith('/img/')) b.image = oldp?.image || null; if (String(b.image_front || '').startsWith('/imgfront/')) b.image_front = oldp?.image_front || null; if (String(b.image_back || '').startsWith('/imgback/')) b.image_back = oldp?.image_back || null; const f = prodFields(b); db.prepare('UPDATE products SET name=?,sku=?,description=?,category=?,price=?,discount=?,stock=?,active=?,image=?,category_id=?,carton_price=?,carton_qty=?,size=?,image_front=?,image_back=?,colors=?,quality=?,video_url=?,featured=?,updated=? WHERE id=?').run(...f, now(), +r[1]); return { ok: true }; }
      if (m === 'DELETE') { if (db.prepare('SELECT 1 FROM order_items WHERE product_id=?').get(+r[1])) { db.prepare('UPDATE products SET active=0 WHERE id=?').run(+r[1]); return { ok: true, note: 'Has past orders, so it was hidden instead of deleted' }; } db.prepare('DELETE FROM products WHERE id=?').run(+r[1]); return { ok: true }; }
    }
  }
  throw new Err(404, 'Not found');
}

http.createServer(async (req, res) => {
  const send = (c, o) => { const h = o._h || {}; delete o._h; res.writeHead(c, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...h }); res.end(JSON.stringify(o)); };
  try {
    if (req.method === 'GET' && !req.url.startsWith('/api')) {
      const u = new URL(req.url, 'http://x').pathname, S = settings(), base = (E.PUBLIC_URL || 'http://' + req.headers.host).replace(/\/$/, ''), CC = E.CURRENCY_CODE || 'NGN';
      const page = (meta, st = 200) => { res.writeHead(st, HDR); res.end(fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8').replace('<!--META-->', meta)); };
      const tags = (t, d, url, img, extra = '', type = 'website') => `<title>${X(t)}</title><meta name="description" content="${X(d)}"><link rel="canonical" href="${X(url)}"><meta property="og:type" content="${type}"><meta property="og:site_name" content="${X(S.name)}"><meta property="og:title" content="${X(t)}"><meta property="og:description" content="${X(d)}"><meta property="og:url" content="${X(url)}">${img ? `<meta property="og:image" content="${X(img)}">` : ''}<meta name="twitter:card" content="${img ? 'summary_large_image' : 'summary'}">${extra}`;
      let m2;
      if (u === '/' || u === '/index.html') return page(tags(S.name + (S.tag ? ' | ' + S.tag : ''), S.tag || S.name, base + '/'));
      if (u === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${base}/sitemap.xml\n`); }
      if (u === '/sitemap.xml') { const L = db.prepare('SELECT id,name,updated FROM products WHERE active=1 AND ' + CV + ' ORDER BY id').all(); res.writeHead(200, { 'content-type': 'application/xml' }); return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${X(base)}/</loc></url>${L.map(p => `<url><loc>${X(base + '/product/' + p.id + '-' + slug(p.name))}</loc><lastmod>${X(p.updated)}</lastmod></url>`).join('')}</urlset>`); }
      if ((m2 = /^\/product\/(\d+)(?:-[a-z0-9-]*)?$/.exec(u))) {
        const p = db.prepare('SELECT id,name,sku,description,price,discount,stock,image IS NOT NULL AS img,updated FROM products WHERE id=? AND active=1 AND ' + CV).get(+m2[1]);
        if (!p) return page('<title>Product not found</title><meta name="robots" content="noindex">', 404);
        const canon = '/product/' + p.id + '-' + slug(p.name);
        if (u !== canon) { res.writeHead(301, { location: canon }); return res.end(); }
        const pr = eff(p), img = p.img ? base + '/img/' + p.id + '?v=' + p.updated.replace(/\D/g, '') : '', desc = (p.description || p.name).replace(/\s+/g, ' ').slice(0, 200);
        const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: p.name, description: desc, sku: p.sku || undefined, image: img || undefined, offers: { '@type': 'Offer', url: base + canon, priceCurrency: CC, price: pr, availability: 'https://schema.org/' + (p.stock > 0 ? 'InStock' : 'OutOfStock') } }).replace(/</g, '\\u003c');
        return page(tags(p.name + ' | ' + S.name, S.cur + pr.toLocaleString('en-NG') + ' - ' + desc, base + canon, img, `<meta property="product:price:amount" content="${pr}"><meta property="product:price:currency" content="${X(CC)}"><script type="application/ld+json">${ld}</script>`, 'product'));
      }
      if ((m2 = /^\/uploads\/videos\/([A-Za-z0-9._-]+)$/.exec(u))) {
        const fn=m2[1]; if(fn.includes('..')||fn.includes('/')||fn.includes('\\')) return send(404,{error:'Not found'}); const fp=path.join(__dirname,'public','uploads','videos',fn); if(!fs.existsSync(fp)) return send(404,{error:'Not found'}); const ext=path.extname(fn).toLowerCase(); const ct={'.mp4':'video/mp4','.webm':'video/webm','.ogg':'video/ogg'}[ext]||'application/octet-stream'; res.writeHead(200,{'content-type':ct,'cache-control':'public, max-age=86400','accept-ranges':'bytes','x-content-type-options':'nosniff'}); return res.end(fs.readFileSync(fp));
      }
      if ((m2 = /^\/imgfront\/(\d+)$/.exec(u))) {
        let adm = false; try { adminOf(req); adm = true; } catch {}
        const x = db.prepare('SELECT image_front FROM products WHERE id=? AND ((active=1 AND ' + CV + ') OR ?)').get(+m2[1], adm ? 1 : 0), mm = x && IMG.exec(x.image_front || '');
        if (!mm) return send(404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': 'image/' + mm[1], 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
        return res.end(Buffer.from(x.image_front.slice(x.image_front.indexOf(',') + 1), 'base64'));
      }
      if ((m2 = /^\/imgback\/(\d+)$/.exec(u))) {
        let adm = false; try { adminOf(req); adm = true; } catch {}
        const x = db.prepare('SELECT image_back FROM products WHERE id=? AND ((active=1 AND ' + CV + ') OR ?)').get(+m2[1], adm ? 1 : 0), mm = x && IMG.exec(x.image_back || '');
        if (!mm) return send(404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': 'image/' + mm[1], 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
        return res.end(Buffer.from(x.image_back.slice(x.image_back.indexOf(',') + 1), 'base64'));
      }
      if ((m2 = /^\/img\/(\d+)$/.exec(u))) {
        let adm = false; try { adminOf(req); adm = true; } catch {}
        const x = db.prepare('SELECT image FROM products WHERE id=? AND ((active=1 AND ' + CV + ') OR ?)').get(+m2[1], adm ? 1 : 0), mm = x && IMG.exec(x.image || '');
        if (!mm) return send(404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': 'image/' + mm[1], 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
        return res.end(Buffer.from(x.image.slice(x.image.indexOf(',') + 1), 'base64'));
      }
      return send(404, { error: 'Not found' });
    }
    const raw = await new Promise((ok, no) => { const b = []; let n = 0; req.on('data', d => { n += d.length; if (n > 15e6) { no(new Err(413, 'Too large')); req.destroy(); } else b.push(d); }); req.on('end', () => ok(Buffer.concat(b))); req.on('error', no); });
    const out = await route(req, res, new URL(req.url, 'http://x'), raw); send(200, Array.isArray(out) ? { items: out } : out);
  } catch (e) { if (!e.c) console.error(e); send(e.c || 500, { error: e.c ? e.message : 'Something went wrong' }); }
}).listen(PORT, () => { console.log('Store on :' + PORT); const bk = () => { try { backup(); } catch (e) { console.error('Backup failed:', e.message); } }; bk(); setInterval(bk, 864e5).unref(); });
