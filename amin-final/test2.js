// Production-hardening tests: categories, images, SEO, payment safety, staff, backup, pagination.
const {spawn}=require('child_process'),crypto=require('crypto'),fs=require('fs'),{DatabaseSync}=require('node:sqlite');
for(const f of ['/tmp/t2.db','/tmp/t2.db-wal','/tmp/t2.db-shm'])try{fs.unlinkSync(f)}catch{}
fs.rmSync('/tmp/bk2',{recursive:true,force:true});
const env={...process.env,PORT:'3998',DB_PATH:'/tmp/t2.db',BACKUP_DIR:'/tmp/bk2',ADMIN_EMAIL:'o@x.com',ADMIN_PASSWORD:'correct-horse-battery',PAYSTACK_SECRET_KEY:'sk_test_dummy',PUBLIC_URL:'http://shop.test'};
const start=()=>spawn('node',['--no-warnings','server.js'],{env,stdio:'ignore'}),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const B='http://localhost:3998';let f=0,n=0;const t=(m,ok)=>{n++;console.log(ok?'PASS':'FAIL',m);if(!ok)f++};
const mk=()=>{let ck='';return async(m,p,b,h={})=>{const r=await fetch(B+p,{method:m,redirect:'manual',headers:{'content-type':'application/json','x-requested-with':'store',cookie:ck,...h},body:b&&(typeof b=='string'?b:JSON.stringify(b))});const sc=r.headers.get('set-cookie');if(sc)ck=sc.split(';')[0];const tx=await r.text();let j;try{j=JSON.parse(tx)}catch{j=tx}return[r.status,j,r]}};
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const DB=()=>new DatabaseSync('/tmp/t2.db');
(async()=>{
 // legacy data: text-only categories must migrate to real category IDs
 let s=start();await sleep(900);s.kill();await sleep(300);
 DB().exec("INSERT INTO products(name,sku,price,stock,active,category,created,updated) VALUES('Legacy Item','LG1',500,4,1,'Legacy','2026-01-01','2026-01-01')");
 s=start();await sleep(900);
 const own=mk(),anon=mk(),stf=mk(),adm=mk();
 await own('POST','/api/admin/login',{email:'o@x.com',password:'correct-horse-battery'});
 const cl=(await own('GET','/api/admin/categories'))[1].items;t('text category migrated to a real category row',cl.some(c=>c.name=='Legacy'&&c.products==1));
 // categories
 const [,c1]=await own('POST','/api/admin/categories',{name:'Shoes'});t('category created',c1.id>0);
 t('duplicate category 409',(await own('POST','/api/admin/categories',{name:'Shoes'}))[0]==409);
 const [,c2]=await own('POST','/api/admin/categories',{name:'Bags'});
 t('invalid category on product rejected',(await own('POST','/api/admin/products',{name:'Bad',price:5,stock:1,category_id:9999}))[0]==400);
 const [,p]=await own('POST','/api/admin/products',{name:'Red Sneakers',sku:'RS1',description:'Comfortable shoes',price:15000,discount:12000,stock:3,category_id:c1.id,image:PNG});t('product with category + image saved',p.id>0);
 t('public filter by category id',(await anon('GET','/api/products?cat='+c1.id))[1].items.length==1&&(await anon('GET','/api/products?cat='+c2.id))[1].items.length==0);
 t('rename category updates products',(await own('PATCH','/api/admin/categories/'+c1.id,{name:'Footwear'}))[0]==200&&(await anon('GET','/api/products/'+p.id))[1].category=='Footwear');
 t('delete category with products blocked (409)',(await own('DELETE','/api/admin/categories/'+c1.id))[0]==409);
 await own('PATCH','/api/admin/categories/'+c1.id,{active:0});
 t('hidden category hides product from list, page, sitemap and orders',(await anon('GET','/api/products'))[1].items.every(x=>x.name!='Red Sneakers')&&(await anon('GET','/api/products/'+p.id))[0]==404&&(await anon('GET','/product/'+p.id))[0]==404&&!(await anon('GET','/sitemap.xml'))[1].includes('red-sneakers')&&(await anon('POST','/api/orders',{customer:{name:'Ada Obi',phone:'08012345678'},address:'12 Main St',state:'Lagos',city:'Ikeja',items:[{id:p.id,qty:1}]}))[0]==409);
 await own('PATCH','/api/admin/categories/'+c1.id,{active:1});
 t('reassign + delete category',(await own('DELETE',`/api/admin/categories/${c2.id}`))[0]==200&&(await own('DELETE',`/api/admin/categories/${cl.find(c=>c.name=='Legacy').id}?reassign=${c1.id}`))[0]==200);
 // images
 t('svg upload rejected',(await own('POST','/api/admin/products',{name:'Svg',price:5,stock:1,image:'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='}))[0]==400);
 t('script disguised as PNG rejected',(await own('POST','/api/admin/products',{name:'Fake',price:5,stock:1,image:'data:image/png;base64,'+Buffer.from('<script>alert(1)</script>padding-padding').toString('base64')}))[0]==400);
 t('oversize image rejected',(await own('POST','/api/admin/products',{name:'Big',price:5,stock:1,image:'data:image/png;base64,'+Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(800e3)]).toString('base64')}))[0]==400);
 const im=await fetch(B+'/img/'+p.id);t('image served with safe headers',im.status==200&&im.headers.get('content-type')=='image/png'&&im.headers.get('x-content-type-options')=='nosniff');
 // SEO
 const slugp=(await anon('GET','/api/products/'+p.id))[1].slug||('/product/'+p.id+'-red-sneakers');
 const pg=await anon('GET','/product/'+p.id+'-red-sneakers'),h=pg[1];
 t('product page has server-rendered OG tags + canonical',pg[0]==200&&/og:title" content="Red Sneakers/.test(h)&&/og:image" content="http:\/\/shop.test\/img\//.test(h)&&/rel="canonical" href="http:\/\/shop.test\/product\/\d+-red-sneakers"/.test(h)&&/og:description/.test(h));
 t('product JSON-LD present with NGN price',/application\/ld\+json/.test(h)&&/"priceCurrency":"NGN"/.test(h)&&/"price":12000/.test(h));
 t('wrong slug redirects to canonical URL',(await anon('GET','/product/'+p.id+'-wrong'))[0]==301);
 t('robots.txt and sitemap.xml served',/Sitemap: http:\/\/shop.test\/sitemap.xml/.test((await anon('GET','/robots.txt'))[1])&&/red-sneakers/.test((await anon('GET','/sitemap.xml'))[1]));
 const [,xp]=await own('POST','/api/admin/products',{name:'X"><script>alert(1)</script>',price:5,stock:1});
 const xh=(await anon('GET','/product/'+xp.id))[1],xr=await anon('GET','/product/'+xp.id+'-x-script-alert-1-script');
 t('product name cannot inject HTML into page head',!/<script>alert\(1\)/.test(xh)&&!/<script>alert\(1\)/.test(xr[1]));
 await own('PUT','/api/admin/products/'+xp.id,{name:'Hidden thing',price:5,stock:1,active:false});
 t('hidden product: 404 + noindex + not in sitemap',(await anon('GET','/product/'+xp.id))[0]==404&&!(await anon('GET','/sitemap.xml'))[1].includes('hidden-thing')&&(await fetch(B+'/img/'+xp.id)).status==404);
 // payments
 const cust={name:'Ada Obi',phone:'08012345678'},ad={address:'12 Main Street',state:'Lagos',city:'Ikeja'};
 const order=async q=>(await anon('POST','/api/orders',{customer:cust,...ad,items:[{id:p.id,qty:q}]}))[1];
 const refs=async no=>{const d=DB();return d.prepare('SELECT reference r FROM payments WHERE order_id=(SELECT id FROM orders WHERE no=?) ORDER BY id').all(no).map(x=>x.r)};
 const hook=(ref,amt,cur='NGN',st='success')=>{const raw=JSON.stringify({event:'charge.success',data:{reference:ref,status:st,amount:amt,currency:cur}});return anon('POST','/api/webhook/paystack',raw,{'x-paystack-signature':crypto.createHmac('sha512','sk_test_dummy').update(raw).digest('hex')})};
 const stock=()=>DB().prepare('SELECT stock s FROM products WHERE id=?').get(p.id).s,view=async(o)=>(await anon('POST','/api/track',{no:o.no,phone:'08012345678'}))[1];
 const A=await order(1),Bo=await order(2);t('server totals: 1x12000+2000, 2x12000+2000',A.total==14000&&Bo.total==26000);
 await anon('POST',`/api/orders/${A.no}/pay`,{});await anon('POST',`/api/orders/${A.no}/pay`,{});await anon('POST',`/api/orders/${Bo.no}/pay`,{});
 const [a1,a2]=await refs(A.no),[b1]=await refs(Bo.no);
 await hook(a1,1400000,'USD');t('wrong currency rejected',(await view(A)).pay_status=='pending');
 await hook(b1,1400000);t("payment for order A's amount cannot pay order B",(await view(Bo)).pay_status=='pending');
 await hook(a1,1400000,'NGN','failed');t('failed payment: order unpaid, stock untouched',(await view(A)).pay_status=='pending'&&stock()==3);
 t('forged/unsigned webhook rejected',(await anon('POST','/api/webhook/paystack',JSON.stringify({event:'charge.success',data:{reference:a1,status:'success',amount:1400000,currency:'NGN'}}),{'x-paystack-signature':'00'}))[0]==401);
 await hook(a1,1400000);t('verified payment marks paid + stock 3->2',(await view(A)).pay_status=='paid'&&stock()==2);
 await hook(a1,1400000);await hook(a1,1400000);t('webhook replay changes nothing (stock still 2)',stock()==2);
 await hook(a2,1400000);t('second successful payment for same order flagged for refund, no second deduction',stock()==2&&DB().prepare('SELECT status s FROM payments WHERE reference=?').get(a2).s=='refund_due');
 await hook(b1,2600000);t('order B paid, stock 2->0',(await view(Bo)).pay_status=='paid'&&stock()==0);
 await own('PUT','/api/admin/products/'+p.id,{name:'Red Sneakers',sku:'RS1',price:15000,discount:12000,stock:3,category_id:c1.id,image:'/img/'+p.id});
 const D=await order(3),E1=await order(1);await anon('POST',`/api/orders/${D.no}/pay`,{});await anon('POST',`/api/orders/${E1.no}/pay`,{});
 const [d1]=await refs(D.no),[e1]=await refs(E1.no);await hook(d1,3800000);await hook(e1,1400000);
 const ev=await view(E1);t('stock gone before 2nd payment: needs_review, no negative stock',ev.status=='needs_review'&&stock()==0);
 t('refund of paid order restores stock exactly once',(await own('PATCH',`/api/admin/orders/${D.no}`,{status:'refunded'}))[0]==200&&stock()==3&&(await own('PATCH',`/api/admin/orders/${D.no}`,{status:'refunded'}))[0]==409&&stock()==3);
 const F=await order(1);await anon('POST',`/api/orders/${F.no}/pay`,{});const [f1]=await refs(F.no);await own('PATCH',`/api/admin/orders/${F.no}`,{status:'cancelled'});await hook(f1,1400000);
 t('late payment on cancelled order: not paid, stock untouched, flagged',(await view(F)).status=='cancelled'&&stock()==3&&DB().prepare('SELECT status s FROM payments WHERE reference=?').get(f1).s=='refund_due');
 t('verify endpoint never trusts client (provider unreachable => not paid)',(await anon('GET','/api/pay/verify?reference='+f1))[0]==502);
 // staff + passwords
 const [,u]=await own('POST','/api/admin/staff',{name:'Sam Staff',email:'s@x.com',password:'staff-password-1',role:'staff'});
 await stf('POST','/api/admin/login',{email:'s@x.com',password:'staff-password-1'});
 t('staff cannot list/create team, change settings or edit products',(await stf('GET','/api/admin/staff'))[0]==403&&(await stf('POST','/api/admin/staff',{name:'Eve',email:'e@x.com',password:'password-1234',role:'admin'}))[0]==403&&(await stf('PUT','/api/admin/settings',{fee:'1'}))[0]==403&&(await stf('POST','/api/admin/products',{name:'No',price:5,stock:1}))[0]==403);
 t('staff can read orders',(await stf('GET','/api/admin/orders'))[0]==200);
 await own('POST','/api/admin/staff',{name:'Amy Admin',email:'a@x.com',password:'admin-password-1',role:'admin'});await adm('POST','/api/admin/login',{email:'a@x.com',password:'admin-password-1'});
 t('admin cannot manage team (owner only) but can manage products',(await adm('GET','/api/admin/staff'))[0]==403&&(await adm('POST','/api/admin/products',{name:'Admin item',price:50,stock:2}))[0]==200);
 t('owner account cannot be changed; role owner not creatable',(await own('PATCH','/api/admin/staff/1',{role:'staff'}))[0]==403&&(await own('POST','/api/admin/staff',{name:'Zed',email:'z@x.com',password:'password-1234',role:'owner'}))[0]==400);
 t('team list leaks no password hashes',!/hash|scrypt/i.test(JSON.stringify((await own('GET','/api/admin/staff'))[1])));
 await own('PATCH','/api/admin/staff/'+u.id,{active:0});t('disabled staff session and login both rejected',(await stf('GET','/api/admin/orders'))[0]==401&&(await mk()('POST','/api/admin/login',{email:'s@x.com',password:'staff-password-1'}))[0]==401);
 await own('PATCH','/api/admin/staff/'+u.id,{active:1});const [,rs]=await own('POST',`/api/admin/staff/${u.id}/reset`,{});
 t('owner reset gives temp password; old password dead',rs.temp_password&&(await mk()('POST','/api/admin/login',{email:'s@x.com',password:'staff-password-1'}))[0]==401&&(await mk()('POST','/api/admin/login',{email:'s@x.com',password:rs.temp_password}))[0]==200);
 t('change own password needs current password',(await adm('POST','/api/admin/password',{current:'wrong',new:'another-long-password'}))[0]==403&&(await adm('POST','/api/admin/password',{current:'admin-password-1',new:'another-long-password'}))[0]==200&&(await mk()('POST','/api/admin/login',{email:'a@x.com',password:'another-long-password'}))[0]==200);
 const rl=mk();let last=0;for(let i=0;i<7;i++)last=(await rl('POST','/api/admin/login',{email:'o@x.com',password:'bad'+i}))[0];t('brute-force login gets rate limited (429)',last==429);
 // pagination + backup
 for(let i=0;i<26;i++)await own('POST','/api/admin/products',{name:'Bulk '+i,price:10,stock:1});
 const pub=(await anon('GET','/api/products?page=2'))[1],ap=(await own('GET','/api/admin/products?page=2'))[1];t('pagination (24 public / 25 admin per page)',pub.items.length>0&&pub.total>24&&ap.items.length>0&&(await anon('GET','/api/products'))[1].items.length==24);
 const bk=fs.readdirSync('/tmp/bk2').filter(x=>/^store-.*\.db$/.test(x));t('automatic backup file created and is a valid database',bk.length>=1&&new DatabaseSync('/tmp/bk2/'+bk[0]).prepare('SELECT COUNT(*) n FROM admins').get().n>=1);
 console.log(f?f+' FAILED':'ALL PASSED',n+' checks');s.kill();process.exit(f?1:0)})().catch(e=>{console.error(e);process.exit(1)});
