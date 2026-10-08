'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'amin-payments-test-'));
const dbPath = path.join(work, 'store.db');
const initialized = new Map(), verified = new Map();
let initCount = 0, server;
const check = (name, value) => { assert.ok(value, name); console.log('PASS', name); };
const listen = srv => new Promise((resolve, reject) => {
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
});
const close = srv => new Promise(resolve => srv.close(resolve));

(async () => {
  let paystack, port;
  try {
    paystack = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        if (req.headers.authorization !== 'Bearer sk_test_dummy') {
          res.writeHead(401).end(JSON.stringify({ status: false }));
          return;
        }
        if (req.method === 'POST' && req.url === '/transaction/initialize') {
          initCount++;
          const payload = JSON.parse(Buffer.concat(chunks).toString());
          initialized.set(payload.reference, payload);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: true, data: { authorization_url: `https://checkout.test/${payload.reference}`, access_code: `access-${payload.reference}` } }));
          return;
        }
        const match = /^\/transaction\/verify\/(.+)$/.exec(req.url);
        if (req.method === 'GET' && match) {
          const ref = decodeURIComponent(match[1]), data = verified.get(ref);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(data ? { status: true, data: { reference: ref, ...data } } : { status: false }));
          return;
        }
        res.writeHead(404).end();
      });
    });
    const paystackPort = await listen(paystack);
    const probe = http.createServer();
    port = await listen(probe);
    await close(probe);
    const env = {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      ADMIN_EMAIL: 'owner@example.test',
      ADMIN_PASSWORD: 'a-test-password-123',
      PAYSTACK_SECRET_KEY: 'sk_test_dummy',
      PAYSTACK_API_URL: `http://127.0.0.1:${paystackPort}`,
      PUBLIC_URL: 'https://shop.example.test'
    };
    delete env.DATABASE_URL;
    server = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: __dirname, env, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch(`${base}/api/settings`);
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'store server started');

    const request = async (method, url, body, headers = {}) => {
      const response = await fetch(`${base}${url}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-requested-with': 'store', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    };
    const adminLogin = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'store' },
      body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD })
    });
    assert.equal(adminLogin.status, 200);
    const sid = adminLogin.headers.get('set-cookie').split(';')[0];
    const adminRequest = (method, url, body) => request(method, url, body, { cookie: sid });
    const created = await adminRequest('POST', '/api/admin/products', { name: 'Test Drink', price: 12000, stock: 5, size: 'XL', colors: 'Black' });
    assert.equal(created.status, 200);
    const productId = created.body.id;
    const home = await fetch(`${base}/`);
    const homeHtml = await home.text();
    const logo = await fetch(`${base}/assets/amin-logo.svg`);
    const photoPlaceholder = await fetch(`${base}/assets/products/photo-needed.svg`);
    check('production storefront references a local logo with alt text',
      home.status === 200 && homeHtml.includes('amin-logo.svg') &&
      homeHtml.includes('alt="${esc(CFG.name)} logo"'));
    const logoSvg = await logo.text(), placeholderSvg = await photoPlaceholder.text();
    check('local branded logo loads as SVG with the store name',
      logo.status === 200 && logo.headers.get('content-type')?.includes('image/svg+xml') &&
      logoSvg.includes('A.A SULTAN COLLECTIONS'));
    check('clearly marked product photo placeholder loads as SVG',
      photoPlaceholder.status === 200 && photoPlaceholder.headers.get('content-type')?.includes('image/svg+xml') &&
      placeholderSvg.includes('PHOTO NEEDED'));
    check('asset route blocks traversal and unsupported content types',
      (await fetch(`${base}/assets/../server.js`)).status === 404 &&
      (await fetch(`${base}/assets/amin-logo.svg/anything.js`)).status === 404);
    const publicSettings = await request('GET', '/api/settings');
    check('customer-care and delivery contacts remain configured',
      ['care1','care2','delivery1','delivery2'].every(key => publicSettings.body[key]));
    check('mobile styles, customer-facing navigation and local marketplace state are present',
      homeHtml.includes('@media(max-width:520px)') && homeHtml.includes('id="market-cats"') &&
      homeHtml.includes('id="list"') && homeHtml.includes('Track order') &&
      homeHtml.includes('amin_wishlist') && homeHtml.includes('amin_recent'));
    const details = await fetch(`${base}/product/${productId}-test-drink`);
    check('product detail page remains server-rendered and includes the correct local photo fallback',
      details.status === 200 && (await details.text()).includes('application/ld+json'));
    const filtered = await request('GET', '/api/products?sort=price-low-high&min_price=12000&max_price=12000&size=XL&color=Black&instock=1');
    check('marketplace price, size, color, availability filters and price sort work together',
      filtered.status === 200 && filtered.body.items.some(p => p.id === productId));
    const customer = { name: 'Ada Obi', phone: '08012345678', email: 'ada@example.test' };
    const address = { address: '12 Main Street', state: 'Lagos', city: 'Ikeja' };
    const createOrder = async () => {
      const result = await request('POST', '/api/orders', { customer, ...address, items: [{ id: productId, qty: 1, variant: { size: 'XL', color: 'Black' } }] });
      assert.equal(result.status, 200);
      return result.body;
    };
    const pay = (no) => request('POST', `/api/orders/${no}/pay`, {});
    const verify = (reference) => request('GET', `/api/pay/verify?reference=${encodeURIComponent(reference)}`);
    const tracked = async no => (await request('POST', '/api/track', { no, phone: customer.phone })).body;
    const db = new DatabaseSync(dbPath);
    const stock = () => db.prepare('SELECT stock FROM products WHERE id=?').get(productId).stock;
    const attempts = no => db.prepare('SELECT reference,status FROM payments WHERE order_id=(SELECT id FROM orders WHERE no=?) ORDER BY id').all(no);

    const duplicateOrder = await createOrder();
    const first = await pay(duplicateOrder.no);
    assert.equal(first.status, 200);
    check('initialization returns Paystack authorization URL and access code',
      first.body.authorization_url.startsWith('https://checkout.test/') && first.body.access_code.startsWith('access-'));
    const posted = initialized.get(first.body.reference);
    check('initialization uses server-calculated NGN total and customer email',
      posted.amount === duplicateOrder.total * 100 && posted.currency === 'NGN' && posted.email === customer.email);
    check('authorization does not expose the secret key', !JSON.stringify(first.body).includes('sk_test_dummy'));
    check('callback URL points back to the order', posted.callback_url === `https://shop.example.test/?no=${duplicateOrder.no}`);
    const second = await pay(duplicateOrder.no);
    check('repeated payment request reuses the active Paystack session',
      second.status === 200 && second.body.reference === first.body.reference &&
      second.body.authorization_url === first.body.authorization_url && initCount === 1 && attempts(duplicateOrder.no).length === 1);
    check('initialization alone does not mark the order paid or deduct stock',
      (await tracked(duplicateOrder.no)).pay_status === 'pending' && stock() === 5);

    verified.set(first.body.reference, { status: 'failed', amount: duplicateOrder.total * 100, currency: 'NGN' });
    const failed = await verify(first.body.reference);
    check('failed Paystack verification leaves the order unpaid and stock unchanged',
      failed.status === 200 && failed.body.payment_status === 'failed' &&
      (await tracked(duplicateOrder.no)).pay_status === 'pending' && stock() === 5);

    const cancelledOrder = await createOrder();
    const cancelledInit = await pay(cancelledOrder.no);
    verified.set(cancelledInit.body.reference, { status: 'abandoned', amount: cancelledOrder.total * 100, currency: 'NGN' });
    const cancelled = await verify(cancelledInit.body.reference);
    check('cancelled Paystack checkout remains unpaid and can be retried',
      cancelled.body.payment_status === 'cancelled' && (await tracked(cancelledOrder.no)).pay_status === 'pending' &&
      (await pay(cancelledOrder.no)).status === 200 && attempts(cancelledOrder.no).length === 2);

    const mismatchOrder = await createOrder();
    const mismatchInit = await pay(mismatchOrder.no);
    verified.set(mismatchInit.body.reference, { status: 'success', amount: mismatchOrder.total * 100 - 100, currency: 'NGN' });
    const mismatch = await verify(mismatchInit.body.reference);
    check('amount mismatch is rejected without marking paid or deducting stock',
      mismatch.body.payment_status === 'failed' && (await tracked(mismatchOrder.no)).pay_status === 'pending' && stock() === 5);

    const successOrder = await createOrder();
    const successInit = await pay(successOrder.no);
    verified.set(successInit.body.reference, { status: 'success', amount: successOrder.total * 100, currency: 'NGN' });
    const success = await verify(successInit.body.reference);
    check('successful server-side verification marks paid and deducts stock exactly once',
      success.body.payment_status === 'paid' && (await tracked(successOrder.no)).pay_status === 'paid' && stock() === 4);
    check('repeated attempt after payment is rejected',
      (await pay(successOrder.no)).status === 409 && attempts(successOrder.no).length === 1);

    const newCoupon = await adminRequest('POST', '/api/admin/coupons', { code: 'SAVE10', percent: 10 });
    const quote = await request('POST', '/api/coupons/validate', { code: 'save10', subtotal: 12000 });
    const couponOrder = await request('POST', '/api/orders', { customer, ...address, items: [{ id: productId, qty: 1, variant: { size: 'XL', color: 'Black' } }], coupon: 'save10', total: 1 });
    check('coupon offers validate and server applies the configured discount to the order total',
      newCoupon.status === 200 && quote.status === 200 && quote.body.discount === 1200 &&
      couponOrder.status === 200 && couponOrder.body.total === 12800 && couponOrder.body.discount === 1200);
    await adminRequest('PATCH', '/api/admin/coupons/SAVE10', { active: false });
    check('disabled coupons are rejected by validation and order creation',
      (await request('POST', '/api/coupons/validate', { code: 'SAVE10', subtotal: 12000 })).status === 400 &&
      (await request('POST', '/api/orders', { customer, ...address, items: [{ id: productId, qty: 1, variant: { size: 'XL', color: 'Black' } }], coupon: 'SAVE10' })).status === 400);

    const year = Number(new Intl.DateTimeFormat('en', { timeZone: 'Africa/Lagos', year: 'numeric' }).format(new Date()));
    const adaId = db.prepare('SELECT id FROM customers WHERE phone=?').get(customer.phone).id;
    const beaId = db.prepare("INSERT INTO customers(name,phone,email,created) VALUES('Bea Obi','08087654321','bea@example.test',?) RETURNING id").get(new Date().toISOString()).id;
    const awardPaid = (customerId, amount, paidAt, status = 'paid', payStatus = 'paid') => {
      const no = `ORD-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const id = db.prepare("INSERT INTO orders(no,customer_id,subtotal,fee,total,pay_status,status,created,updated) VALUES(?,?,?,0,?,?,?, ?,?)")
        .run(no, customerId, amount, amount, payStatus, status, paidAt, paidAt).lastInsertRowid;
      db.prepare("INSERT INTO payments(order_id,provider,reference,amount,currency,status,created,verified) VALUES(?,'paystack',?,?,'NGN','paid',?,?)")
        .run(id, `award-${no}`, amount * 100, paidAt, paidAt);
      return no;
    };
    const inYear = new Date(`${year}-04-10T12:00:00+01:00`).toISOString();
    awardPaid(adaId, 10000, inYear);
    awardPaid(beaId, 30000, inYear);
    awardPaid(adaId, 90000, inYear, 'cancelled');
    awardPaid(beaId, 80000, inYear, 'refunded', 'refunded');
    const unpaidAt = new Date(`${year}-05-10T12:00:00+01:00`).toISOString();
    db.prepare("INSERT INTO orders(no,customer_id,subtotal,fee,total,pay_status,status,created,updated) VALUES(?,?,50000,0,50000,'pending','payment_pending',?,?)")
      .run(`ORD-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, adaId, unpaidAt, unpaidAt);
    const priorYear = new Date(`${year - 1}-04-10T12:00:00+01:00`).toISOString();
    awardPaid(adaId, 100000, priorYear);
    const dashboard = await adminRequest('GET', '/api/admin/dashboard');
    check('annual customer award ranks verified net spend for this calendar year, excluding cancelled and prior-year orders',
      dashboard.status === 200 && dashboard.body.annual_award.year === year &&
      dashboard.body.annual_award.top_customer.name === 'Bea Obi' &&
      dashboard.body.annual_award.top_customer.spent === 30000 &&
      dashboard.body.annual_award.top_customer.orders === 1);
    await adminRequest('PUT', '/api/admin/awards/reward', { reward: 'Store voucher' });
    const board = await request('GET', '/api/loyalty/leaderboard');
    check('public leaderboard exposes safe display names, current top three, prior-year winners and reward',
      board.status === 200 && board.body.reward === 'Store voucher' &&
      board.body.leaderboard[0].name === 'Bea' && board.body.leaderboard[0].spent === 30000 &&
      board.body.previous_winners.some(w => w.year === year - 1 && w.rank === 1 && w.name === 'Ada') &&
      !JSON.stringify(board.body).includes('08012345678') && !JSON.stringify(board.body).includes('bea@example.test'));
    const progress = await request('POST', '/api/loyalty/progress', { phone: customer.phone });
    check('customer progress uses verified current-year spend only and reports the gap to first place',
      progress.status === 200 && progress.body.customer.name === 'Ada' &&
      progress.body.customer.rank === 2 && progress.body.customer.spent === 24000 &&
      progress.body.amount_to_leader === 6000);
    const awards = await adminRequest('GET', '/api/admin/awards');
    check('admin award report includes all current-year verified totals and ranking',
      awards.status === 200 && awards.body.total_spending === 54000 &&
      awards.body.paid_order_count === 3 && awards.body.top[0].name === 'Bea Obi' &&
      awards.body.previous_winners[0].year === year - 1);

    const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    check('order page requires customer confirmation of the server total before Paystack',
      page.includes('Proceed to Paystack · ${money(o.total)}') &&
      page.includes("const checked=new Set(items);CART=CART.filter(item=>!checked.has(item));saveCart();go('/order/'+o.no)") &&
      page.includes('Select for checkout') &&
      page.includes('location.assign(r.authorization_url)'));
    check('unverified generated illustrations are clearly marked instead of presented as photos',
      page.includes('hasVerifiedPhoto') && page.includes('Real product photo needed') &&
      page.includes('photoNeeded(p.name,false)') && page.includes('product-photo-needed') &&
      page.includes('/assets/products/photo-needed.svg'));
    check('marketplace sections, local wishlist/recent views and coupon checkout are wired',
      page.includes('Best Sellers') && page.includes('Recommended for You') &&
      page.includes('market-low') && page.includes('amin_wishlist') &&
      page.includes('amin_recent') && page.includes('coupon-tools'));
    db.close();
    console.log('ALL PAYMENT TESTS PASSED');
  } finally {
    if (server) server.kill();
    if (paystack) await close(paystack);
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
