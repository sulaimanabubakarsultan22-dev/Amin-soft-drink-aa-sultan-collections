'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'amin-shopping-test-'));
const dbPath = path.join(work, 'store.db');
const productPhoto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aYQAAAAASUVORK5CYII=';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let store, paystack;
let storePort, paystackPort, verificationStatus = 'pending', verificationAmount = 0;
const initialized = [];
const checks = [];
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
  console.log('PASS', name);
};

async function port() {
  const socket = http.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const number = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return number;
}

function respond(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function startPaystack() {
  paystack = http.createServer(async (req, res) => {
    if (req.url === '/transaction/initialize' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      initialized.push(body);
      return respond(res, 200, { status: true, data: { authorization_url: 'https://paystack.test/checkout', access_code: 'test-access' } });
    }
    if (req.url.startsWith('/transaction/verify/')) {
      const reference = decodeURIComponent(req.url.slice('/transaction/verify/'.length));
      return respond(res, 200, {
        status: true,
        data: { status: verificationStatus, amount: verificationAmount, currency: 'NGN', reference }
      });
    }
    return respond(res, 404, { status: false });
  });
  await new Promise(resolve => paystack.listen(0, '127.0.0.1', resolve));
  paystackPort = paystack.address().port;
}

async function run() {
  await startPaystack();
  storePort = await port();
  const env = {
    ...process.env,
    PORT: String(storePort),
    DB_PATH: dbPath,
    ADMIN_EMAIL: 'owner@example.test',
    ADMIN_PASSWORD: 'a-test-owner-password',
    PAYSTACK_SECRET_KEY: 'sk_test_local_fixture',
    PAYSTACK_API_URL: `http://127.0.0.1:${paystackPort}`,
    DELIVERY_FEE: '2500',
    PUBLIC_URL: `http://127.0.0.1:${storePort}`
  };
  delete env.DATABASE_URL;
  store = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: __dirname, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${storePort}/api`;
  let cookie = '';
  const request = async (method, endpoint, data, headers = {}) => {
    const response = await fetch(base + endpoint, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'store',
        ...(cookie ? { cookie } : {}),
        ...headers
      },
      body: data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data)
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: await response.json() };
  };

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (store.exitCode !== null) throw new Error('Store server exited before it became ready');
    try {
      if ((await fetch(base + '/settings')).ok) { ready = true; break; }
    } catch {}
    await sleep(100);
  }
  assert.ok(ready, 'Store API started');
  check('admin login works for product setup', (await request('POST', '/admin/login', { email: 'owner@example.test', password: 'a-test-owner-password' })).status === 200);

  const drink = (await request('POST', '/admin/products', {
    name: 'Regression Cola', sku: 'REG-COLA', product_type: 'DRINK', price: 100, carton_price: 2100, carton_qty: 24, stock: 120, best_seller: true
  })).body;
  const discountedCarton = (await request('POST', '/admin/products', {
    name: 'Regression Discounted Carton', sku: 'REG-DISCOUNT-CARTON', product_type: 'DRINK',
    price: 100, discount: 90, carton_price: 2200, carton_qty: 24, stock: 120
  })).body;
  const unitOnlyDrink = await request('POST', '/admin/products', {
    name: 'Regression Unit Only Drink', sku: 'REG-UNIT-ONLY', product_type: 'DRINK', price: 75, stock: 12
  });
  const partialCartonDrink = await request('POST', '/admin/products', {
    name: 'Regression Incomplete Carton', sku: 'REG-PARTIAL-CARTON', product_type: 'DRINK', price: 75, carton_price: 500, stock: 12
  });
  const clothing = (await request('POST', '/admin/products', {
    name: 'Regression Jallabiya', sku: 'REG-JALLABIYA', product_type: 'CLOTHING', price: 15000,
    stock: 30, size: 'S, M, L', colors: 'Black, Blue', style: 'Embroidered, Plain', new_arrival: true, image: productPhoto
  })).body;
  const goods = (await request('POST', '/admin/products', {
    name: 'Regression Sewing Kit', sku: 'REG-GOODS', product_type: 'GOODS', price: 2500, stock: 8, flash_deal: true, low_stock: true
  })).body;
  const womensCategory = (await request('POST', '/admin/categories', { name: "Women's Clothing" })).body;
  const womensProduct = (await request('POST', '/admin/products', {
    name: 'Regression Women Dress', sku: 'REG-WOMEN', category_id: womensCategory.id, product_type: 'CLOTHING', price: 8000, stock: 10
  })).body;
  check('admin product type controls and drink-only carton fields save', drink.id > 0 && clothing.id > 0 && goods.id > 0);
  check('drinks can be sold by unit without configuring cartons', unitOnlyDrink.status === 200 && unitOnlyDrink.body.id > 0);
  check('carton price and carton quantity must be configured together', partialCartonDrink.status === 400);
  check('carton offers compare carton price with discounted unit prices', (await request('GET', '/products?offer=1')).body.items.some(item => item.id === drink.id) && !(await request('GET', '/products?offer=1')).body.items.some(item => item.id === discountedCarton.id));
  const products = await request('GET', `/products/${drink.id}`);
  check('public product details return explicit product type', products.body.product_type === 'DRINK');
  const drinkList = await request('GET', '/products?type=drink');
  const clothingList = await request('GET', '/products?type=CLOTHING');
  check('storefront filters drinks and clothing separately', drinkList.body.items.some(item => item.id === drink.id) && drinkList.body.items.every(item => item.product_type === 'DRINK') && clothingList.body.items.some(item => item.id === clothing.id) && clothingList.body.items.every(item => item.product_type === 'CLOTHING'));
  check('admin merchandising flags and style options are returned and persisted', (await request('GET', '/products/'+drink.id)).body.best_seller === 1 && (await request('GET', '/products/'+clothing.id)).body.style === 'Embroidered, Plain' && (await request('GET', '/products/'+goods.id)).body.flash_deal === 1);
  check('admin low-stock control persists and includes flagged products in low-stock results', (await request('GET', '/products/'+goods.id)).body.low_stock === 1 && (await request('GET', '/products?low_stock=1')).body.items.some(item => item.id === goods.id));
  const goodsDetails = (await request('GET', '/products/'+goods.id)).body;
  const updatedGoods = await request('PUT', '/admin/products/'+goods.id, { ...goodsDetails, low_stock: false });
  check('admin product updates can clear the low-stock flag', updatedGoods.status === 200 && (await request('GET', '/products/'+goods.id)).body.low_stock === 0);
  const bestSellers = await request('GET', '/products?best_seller=1'), newArrivals = await request('GET', '/products?new_arrival=1'), flashDeals = await request('GET', '/products?flash_deal=1');
  const drinkGroup = await request('GET', '/products?group=drinks'), womenGroup = await request('GET', '/products?group=womens-clothing');
  const menGroup = await request('GET', '/products?group=mens-clothing'), sewingGroup = await request('GET', '/products?group=sewing-materials');
  check('best-seller, new-arrival, and flash-deal product flags filter correctly', bestSellers.body.items.some(item => item.id === drink.id) && newArrivals.body.items.some(item => item.id === clothing.id) && flashDeals.body.items.some(item => item.id === goods.id));
  check('drink and gender-specific clothing category groups return the right products', drinkGroup.body.items.every(item => item.product_type === 'DRINK') && womenGroup.body.items.some(item => item.id === womensProduct.id) && !menGroup.body.items.some(item => item.id === womensProduct.id));
  check('sewing materials category group includes sewing goods', sewingGroup.body.items.some(item => item.id === goods.id));
  check('products can be sorted by discount', (await request('GET', '/products?sort=discount')).status === 200);
  check('invalid marketplace category groups are rejected', (await request('GET', '/products?group=unknown')).status === 400);
  check('invalid product type filter is rejected', (await request('GET', '/products?type=FOOD')).status === 400);
  check('goods cannot be saved with carton pricing', (await request('POST', '/admin/products', {
    name: 'Invalid carton goods', product_type: 'GOODS', price: 100, carton_price: 500, carton_qty: 6, stock: 20
  })).status === 400);
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE products SET carton_price=5000,carton_qty=4 WHERE id=?').run(goods.id);
  db.close();
  const hiddenCartonGoods = await request('GET', `/products/${goods.id}`);
  check('existing goods carton data is hidden from public product responses', hiddenCartonGoods.body.carton_price === null && hiddenCartonGoods.body.carton_qty === null);

  const delivery = { customer: { name: 'Ada Obi', phone: '08012345678' }, address: '12 Main Street', state: 'Lagos', city: 'Ikeja' };
  const order = async items => request('POST', '/orders', { ...delivery, delivery_option: 'standard', items });
  const unitOnlyOrder = await order([{ id: unitOnlyDrink.body.id, qty: 2, pack: 'unit' }]);
  check('unit-only drinks can be ordered while carton checkout stays unavailable', unitOnlyOrder.status === 200 && unitOnlyOrder.body.subtotal === 150 && (await order([{ id: unitOnlyDrink.body.id, qty: 1, pack: 'carton' }])).status === 400);
  const unit = await order([{ id: drink.id, qty: 3, pack: 'unit', price: 1 }]);
  check('drink unit purchase uses server unit price for quantity three', unit.body.subtotal === 300 && unit.body.total === 2800);
  check('drink unit line subtotal and delivery fee are explicit', unit.body.items[0].subtotal === 300 && unit.body.fee === 2500);

  const oneCarton = await order([{ id: drink.id, qty: 1, pack: 'carton' }]);
  check('drink carton purchase uses carton price and carton quantity', oneCarton.body.subtotal === 2100 && oneCarton.body.items[0].pack_qty === 24);
  const twoCartons = await order([{ id: drink.id, qty: 2, pack: 'carton' }]);
  check('multiple drink cartons multiply the carton price', twoCartons.body.subtotal === 4200 && twoCartons.body.items[0].qty === 2);

  const singleClothing = await order([{ id: clothing.id, qty: 1, pack: 'unit', variant: { size: 'S', color: 'Black', style: 'Plain' } }]);
  const threeClothing = await order([{ id: clothing.id, qty: 3, pack: 'unit', variant: { size: 'M', color: 'Black', style: 'Plain' } }]);
  check('clothing single-item order uses the individual unit price', singleClothing.body.subtotal === 15000);
  check('three clothing items calculate the 45,000-naira subtotal', threeClothing.body.subtotal === 45000);
  check('clothing carton requests are rejected', (await order([{ id: clothing.id, qty: 1, pack: 'carton' }])).status === 400);
  check('size and color are required for variant products', (await order([{ id: clothing.id, qty: 1, pack: 'unit' }])).status === 400);
  check('style is required when clothing has selectable style options', (await order([{ id: clothing.id, qty: 1, variant: { size: 'M', color: 'Black' } }])).status === 400);
  check('valid size, color, and style variants are snapshotted in order', (await order([{ id: clothing.id, qty: 1, variant: { size: 'M', color: 'Black', style: 'Plain' } }])).body.items[0].variant.style === 'Plain');
  check('invalid size and color selections are rejected', (await order([{ id: clothing.id, qty: 1, variant: { size: 'XXL', color: 'Green' } }])).status === 400);

  const multiple = await order([
    { id: drink.id, qty: 2, pack: 'carton' },
    { id: clothing.id, qty: 3, pack: 'unit', variant: { size: 'L', color: 'Blue', style: 'Embroidered' } },
    { id: goods.id, qty: 2, pack: 'unit' }
  ]);
  check('multiple selected products calculate one combined subtotal', multiple.body.subtotal === 54200 && multiple.body.items.length === 3);
  check('variant selection and pack type are included in the order summary', multiple.body.items[0].pack === 'carton' && multiple.body.items[1].variant.size === 'L' && multiple.body.items[1].variant.color === 'Blue');
  check('style selection is retained in order item variants', multiple.body.items[1].variant.style === 'Embroidered');
  check('grand total adds configured standard delivery exactly once', multiple.body.fee === 2500 && multiple.body.total === 56700);
  check('unsupported delivery option is rejected', (await request('POST', '/orders', { ...delivery, delivery_option: 'overnight', items: [{ id: goods.id, qty: 1 }] })).status === 400);
  check('stock is checked for clothing quantity', (await order([{ id: clothing.id, qty: 31, variant: { size: 'M', color: 'Black', style: 'Plain' } }])).status === 409);
  check('stock is checked using units contained in cartons', (await order([{ id: drink.id, qty: 6, pack: 'carton' }])).status === 409);

  const payment = await request('POST', `/orders/${multiple.body.no}/pay`, {});
  check('existing Paystack initialization continues to be used', payment.status === 200 && payment.body.authorization_url === 'https://paystack.test/checkout');
  check('Paystack receives server-computed grand total in kobo and NGN', initialized.at(-1).amount === 5670000 && initialized.at(-1).currency === 'NGN');
  let tracked = await request('POST', '/track', { no: multiple.body.no, phone: delivery.customer.phone });
  check('order remains unpaid after Paystack initialization', tracked.body.pay_status === 'pending');
  verificationAmount = initialized.at(-1).amount;
  verificationStatus = 'pending';
  await request('GET', `/pay/verify?reference=${encodeURIComponent(payment.body.reference)}`);
  tracked = await request('POST', '/track', { no: multiple.body.no, phone: delivery.customer.phone });
  check('order remains unpaid while Paystack verification is pending', tracked.body.pay_status === 'pending');
  verificationStatus = 'success';
  await request('GET', `/pay/verify?reference=${encodeURIComponent(payment.body.reference)}`);
  tracked = await request('POST', '/track', { no: multiple.body.no, phone: delivery.customer.phone });
  check('order becomes paid only after successful Paystack verification', tracked.body.pay_status === 'paid');
  check('verified order retains item photo, delivery option, and selected variants', tracked.body.items.length === 3 && tracked.body.items[1].image?.startsWith(`/img/${clothing.id}?`) && tracked.body.items[1].variant.color === 'Blue' && tracked.body.delivery_option === 'standard');

  const paymentDb = new DatabaseSync(dbPath);
  const paid = paymentDb.prepare("SELECT amount,currency,status FROM payments WHERE reference=?").get(payment.body.reference);
  check('payment record stores the NGN amount as whole naira against order total', paid.amount === multiple.body.total && paid.currency === 'NGN' && paid.status === 'paid');
  paymentDb.close();

  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  check('storefront selection and confirmation controls require delivery before Paystack', html.includes('Add to Cart') && html.includes('delivery-option') && html.includes('Proceed to Paystack'));
  check('storefront offers distinct drink, clothing, and goods shopping filters', html.includes('Shop by product type') && html.includes('data-type="DRINK"') && html.includes('data-type="CLOTHING"') && html.includes('data-type="GOODS"'));
  check('storefront supports selection checkboxes, category filters, styles, and marketplace sort', html.includes('Select for checkout') && html.includes('mens-clothing') && html.includes('style-filter') && html.includes('value="discount"'));
  check('cart persists selection and sends only checked lines into checkout totals', html.includes('selectedItems=()=>CART.filter(item=>item.selected!==false)') && html.includes('sub(items)') && html.includes('items:items.map(c=>({id:c.id'));
  check('admin form exposes merchandising flags, low-stock control, and selectable style options', html.includes('name="best_seller"') && html.includes('name="new_arrival"') && html.includes('name="flash_deal"') && html.includes("input.name='low_stock'") && html.includes('name="style"'));
  check('product details include a photo gallery, honest rating status, wishlist, and recommendations', html.includes('product-thumbnails') && html.includes('Not yet rated') && html.includes('Wishlist') && html.includes('Recommended Products'));
  check('carton savings are shown on product cards and drink details', html.includes('market-carton-savings') && html.includes('vs. buying units'));
  console.log(`ALL SHOPPING REGRESSION TESTS PASSED (${checks.length})`);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (store && store.exitCode === null) store.kill();
  if (paystack) await new Promise(resolve => paystack.close(resolve));
  fs.rmSync(work, { recursive: true, force: true });
});
