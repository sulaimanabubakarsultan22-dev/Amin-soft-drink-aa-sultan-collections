import subprocess,time,os,hmac,hashlib,json,sqlite3,urllib.request,base64
from playwright.sync_api import sync_playwright
DB='/tmp/b.db'
for f in (DB,DB+'-wal',DB+'-shm'):
    try: os.remove(f)
    except: pass
env={**os.environ,'PORT':'4000','DB_PATH':DB,'ADMIN_EMAIL':'owner@shop.com','ADMIN_PASSWORD':'correct-horse-battery','PAYSTACK_SECRET_KEY':'sk_test_dummy','PUBLIC_URL':'http://localhost:4000','BACKUP_DIR':'/tmp/bk-e2e'}
def start(): 
    p=subprocess.Popen(['node','--no-warnings','server.js'],env=env,cwd='/mnt/user-data/outputs/store-backend');time.sleep(1);return p
U='http://localhost:4000';res=[];errs=[]
def t(n,ok): res.append(ok);print('PASS' if ok else 'FAIL',n)
def hook(ref,amt):
    raw=json.dumps({'event':'charge.success','data':{'reference':ref,'status':'success','amount':amt,'currency':'NGN'}}).encode()
    r=urllib.request.Request(U+'/api/webhook/paystack',raw,{'content-type':'application/json','x-paystack-signature':hmac.new(b'sk_test_dummy',raw,hashlib.sha512).hexdigest()});return urllib.request.urlopen(r).status
open('/tmp/p.png','wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='))
srv=start()
def a11y(pg,n):
    bad=pg.evaluate("() => [...document.querySelectorAll('#app input:not([type=hidden]),#app select,#app textarea')].filter(e=>!(e.labels&&e.labels.length)&&!e.getAttribute('aria-label')).length")
    imgs=pg.evaluate("() => [...document.images].filter(i=>!i.hasAttribute('alt')).length")
    t(n+': every form field labelled, every image has alt',bad==0 and imgs==0)
def noscroll(pg,n): t(n+': no horizontal scroll',pg.evaluate('() => document.documentElement.scrollWidth<=window.innerWidth+1'))
with sync_playwright() as pw:
    b=pw.chromium.launch()
    adm=b.new_context(viewport={'width':375,'height':740},is_mobile=True).new_page()   # ADMIN on a phone
    cus=b.new_context(viewport={'width':390,'height':844},is_mobile=True,permissions=[]).new_page() # separate CUSTOMER device
    adm.set_default_timeout(8000);cus.set_default_timeout(8000)
    for pg in (adm,cus):
        pg.on('console',lambda m:errs.append(m.text) if m.type=='error' else None);pg.on('pageerror',lambda e:errs.append(str(e)))
    # --- admin: login, add product, settings
    adm.goto(U+'/#/admin');adm.fill('input[name=email]','owner@shop.com');adm.fill('input[name=password]','wrong');adm.click('button:has-text("Login")')
    t('wrong password shows error',adm.wait_for_selector('#toast:visible').inner_text().startswith('Incorrect'))
    adm.fill('input[name=password]','correct-horse-battery');adm.click('button:has-text("Login")');adm.wait_for_selector('text=Total sales')
    t('admin dashboard loads',True);noscroll(adm,'admin dashboard mobile')
    adm.click('.chip:has-text("Categories")');adm.fill('#cf2 input[name=name]','Shoes');adm.click('#cf2 button');adm.wait_for_selector('td:has-text("Shoes")');t('category created in admin',True);noscroll(adm,'admin categories mobile')
    adm.click('.chip:has-text("Products")');adm.click('text=+ Add product')
    adm.fill('input[name=name]','Red Sneakers');adm.fill('input[name=sku]','RS-1');adm.select_option('select[name=category_id]',label='Shoes');adm.fill('textarea[name=description]','Comfortable running shoes');adm.fill('input[name=price]','15000');adm.fill('input[name=discount]','12000');adm.fill('input[name=stock]','5')
    adm.set_input_files('#pi','/tmp/p.png');adm.wait_for_function("() => document.querySelector('#pv').src.startsWith('data:')");noscroll(adm,'admin product form mobile')
    adm.click('button:has-text("Save")');adm.wait_for_selector('td:has-text("Red Sneakers")');t('product saved and listed',True)
    adm.click('.chip:has-text("Settings")');adm.fill('input[name=wa]','2348012345678');adm.fill('input[name=fee]','2000');adm.click('text=Save settings');adm.wait_for_function("() => document.querySelector('#toast').textContent==='Settings saved'");t('settings saved',True)
    # --- customer: browse, search by SKU, product, cart, checkout
    cus.goto(U+'/');cus.wait_for_selector('.pc');a11y(cus,'storefront');cus.click('.chip:has-text("Shoes")');cus.wait_for_selector('.pc');t('category filter by id works',cus.locator('.pc').count()==1);t('storefront shows DB product',cus.inner_text('.pc')!='' and 'Red Sneakers' in cus.inner_text('#list'));noscroll(cus,'storefront mobile')
    cus.fill('#sq','RS-1');cus.wait_for_selector('.pc');cus.fill('#sq','zzzz');cus.wait_for_selector('text=No products found');cus.fill('#sq','RS-1');cus.wait_for_selector('.pc')
    cus.click('.pc');cus.wait_for_selector('text=Add to cart');t('clean product URL (no #)',bool(__import__('re').search(r'/product/\d+-red-sneakers$',cus.url)));a11y(cus,'product page')
    fb=cus.get_attribute('a:has-text("Facebook")','href');t('share links use the clean product URL',('%2Fproduct%2F1-red-sneakers' in fb))
    html=urllib.request.urlopen(U+'/product/1-red-sneakers').read().decode();t('server HTML has OG title/image/canonical for crawlers',all(k in html for k in ('og:title','og:image','rel="canonical"','application/ld+json','Red Sneakers')))
    cus.goto(U+'/');cus.wait_for_selector('.pc')
    for _ in range(25):
        cus.keyboard.press('Tab')
        if cus.evaluate("() => document.activeElement.classList.contains('pc')"): break
    cus.keyboard.press('Enter');cus.wait_for_selector('text=Add to cart');t('keyboard: Tab to product card + Enter opens it',True)
    t('discount shown',cus.inner_text('.old')=='₦15,000');noscroll(cus,'product page mobile')
    cus.fill('#pq','2');cus.click('button:has-text("Add to cart")');cus.reload();t('cart persists after reload',cus.inner_text('#cc')=='2')
    cus.goto(U+'/#/cart');cus.wait_for_selector('text=Checkout');cus.click('button:has-text("Checkout")');cus.wait_for_selector('#cf')
    cus.fill('input[name=name]','Ada Obi');cus.fill('input[name=phone]','123');cus.fill('input[name=state]','Lagos');cus.fill('input[name=city]','Ikeja');cus.fill('textarea[name=addr]','12 Main Street');cus.click('#pb')
    t('bad phone blocked',cus.wait_for_selector('#toast:visible').inner_text().startswith('Enter a valid Nigerian'))
    cus.fill('input[name=phone]','08012345678');noscroll(cus,'checkout mobile');cus.click('#pb');cus.dblclick('#pb',timeout=1500) if False else None
    cus.wait_for_selector('text=Order ORD-')
    t('payment init fails offline: shows FAILED not success',cus.wait_for_selector('text=Payment failed').is_visible() and 'Payment successful' not in cus.inner_text('#app'))
    no=cus.inner_text('h2').split()[-1];c=sqlite3.connect(DB);ref=c.execute('select reference from payments').fetchone()[0]
    t('exactly one order created',c.execute('select count(*) from orders').fetchone()[0]==1)
    t('order total computed by server (2x12000+2000)',c.execute('select total from orders').fetchone()[0]==26000)
    t('stock untouched before payment',c.execute('select stock from products').fetchone()[0]==5)
    t('wrong-amount webhook does not mark paid',(hook(ref,100),cus.click('text=Refresh status'),cus.wait_for_selector('text=Payment failed'))[2] is not None)
    hook(ref,2600000);cus.click('text=Refresh status');cus.wait_for_selector('text=Payment successful');t('verified payment shows successful',True)
    t('stock deducted 5 -> 3',sqlite3.connect(DB).execute('select stock from products').fetchone()[0]==3)
    # tracking from a clean page
    cus.goto(U+'/#/track');cus.fill('#tn',no);cus.fill('#tp','08099999999');cus.click('#app button:has-text("Track")');t('track with wrong phone reveals nothing','No order found' in cus.wait_for_selector('text=No order found').inner_text())
    cus.fill('#tp','08012345678');cus.click('button:has-text("View order")');cus.wait_for_selector('text=Timeline');t('track with right phone works',True)
    # --- admin (other device) sees it
    adm.click('.chip:has-text("Orders")');adm.wait_for_selector('text='+no);t('admin sees customer order from other device',True)
    t('admin sees Paid',adm.locator('.tag:has-text("Payment: Paid")').count()==1);noscroll(adm,'admin orders mobile')
    adm.select_option('select[aria-label="Update status"]','processing');adm.wait_for_selector('.tag:has-text("Order: Processing")')
    adm.click('.chip:has-text("Customers")');adm.click('td:has-text("Ada Obi")');adm.wait_for_selector('text=Order history');t('customer + history',True);noscroll(adm,'admin customers mobile')
    adm.click('.chip:has-text("Payments")');adm.wait_for_selector('text='+ref[:12]);t('payment visible, no mark-paid button',adm.locator('text=/mark.*paid/i').count()==0);noscroll(adm,'admin payments mobile')
    cus.goto(U+'/#/order/'+no);cus.reload();cus.wait_for_selector('text=Processing');t('customer sees updated status',True)
    # layouts
    for w,h,n in((768,1024,'tablet'),(1280,800,'desktop')):
        pg=b.new_context(viewport={'width':w,'height':h}).new_page();pg.goto(U+'/');pg.wait_for_selector('.pc');noscroll(pg,'storefront '+n)
    for w,h,n in((768,1024,'tablet'),(1280,800,'desktop')):
        ap=b.new_context(viewport={'width':w,'height':h}).new_page();ap.set_default_timeout(8000);ap.on('pageerror',lambda e:errs.append(str(e)))
        ap.goto(U+'/#/admin');ap.fill('input[name=email]','owner@shop.com');ap.fill('input[name=password]','correct-horse-battery');ap.click('button:has-text("Login")');ap.wait_for_selector('text=Total sales')
        for tab in ['Dashboard','Products','Categories','Orders','Customers','Payments','Settings','Staff']:
            ap.click(f'.chip:has-text("{tab}")');ap.wait_for_timeout(350);noscroll(ap,f'admin {tab} {n}');a11y(ap,f'admin {tab} {n}')
        ap.click('.chip:has-text("Products")');ap.click('text=+ Add product');ap.wait_for_selector('#pf');noscroll(ap,f'admin product form {n}')
        cp=b.new_context(viewport={'width':w,'height':h}).new_page();cp.goto(U+'/product/1-red-sneakers');cp.wait_for_selector('text=Add to cart');noscroll(cp,f'product page {n}')
    adm.click('button:has-text("Logout")');adm.wait_for_selector('text=Admin login');t('logout',True)
    t('admin API blocked after logout',adm.evaluate("() => fetch('/api/admin/orders').then(r=>r.status)")==401)
    t('no secret in served page','sk_test' not in urllib.request.urlopen(U+'/').read().decode())
    # restart persistence
    srv.terminate();srv.wait();srv=start()
    adm.goto(U+'/#/admin');adm.reload();adm.fill('input[name=email]','owner@shop.com');adm.fill('input[name=password]','correct-horse-battery');adm.click('button:has-text("Login")');adm.wait_for_selector('text=Total sales')
    adm.click('.chip:has-text("Orders")');adm.wait_for_selector('text='+no);adm.click('.chip:has-text("Products")');adm.wait_for_selector('td:has-text("Red Sneakers")');adm.click('.chip:has-text("Payments")');adm.wait_for_selector('text='+ref[:12])
    t('settings persisted across restart',__import__('json').load(urllib.request.urlopen(U+'/api/settings'))['wa']=='2348012345678')
    t('after restart: admin login, product, order, payment all persist',True)
    b.close()
srv.terminate()
print('console errors:',[e for e in errs if 'Failed to load resource' not in e and 'status of 5' not in e] or 'none (ignoring expected 4xx/5xx resource logs)')
print('E2E','ALL PASSED' if all(res) else 'FAILURES',len(res))
