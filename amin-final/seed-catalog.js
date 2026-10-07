'use strict';
const fs=require('fs'),path=require('path');
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.DB_PATH||'store.db');
const catalog=JSON.parse(fs.readFileSync(path.join(__dirname,'catalog.json'),'utf8'));
const now=()=>new Date().toISOString();
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,sku TEXT UNIQUE,description TEXT,category TEXT,price INTEGER NOT NULL CHECK(price>0),discount INTEGER DEFAULT 0 CHECK(discount>=0),stock INTEGER NOT NULL CHECK(stock>=0),active INTEGER DEFAULT 1,image TEXT,created TEXT,updated TEXT,carton_price INTEGER,carton_qty INTEGER,size TEXT,category_id INTEGER REFERENCES categories(id));
`);
for (const q of ["ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES categories(id)","ALTER TABLE products ADD COLUMN carton_price INTEGER","ALTER TABLE products ADD COLUMN carton_qty INTEGER","ALTER TABLE products ADD COLUMN size TEXT"]) { try { db.exec(q); } catch {} }
const categoryNames={
  "Soft Drinks":"Drinks",
  "Dairy Drinks":"Drinks",
  "Juices":"Juice",
  "Water & Beverages":"Water",
  "Clothes (Riguna)":"Women's Clothing",
  "Maza – Maza (Babbar Rigar / Ƙaramar Riga / Jamfa / Jallabiya)":"Men's Clothing",
  "Mata – Mata (Riguna / Hijabi / Kayan Ɗinki)":"Women's Clothing",
  "Jarirai da Yara – Baby & Kids":"Children's Clothing"
};
const getCat=db.prepare('SELECT id FROM categories WHERE name=?');
for(const name of catalog.categories) db.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)').run(name);
const nameAliases={
  'Coca Cola':'Coca-Cola',
  'Nutri-milk':'Nutri-Milk',
  'Lacasera':'La Casera',
  '5Alive Big & Small':'5 Alive'
};
const productCategory={
  'Mr V':'Water',
  'Peach':'Juice',
  'Predator':'Energy Drinks',
  'Yugo':'Drinks'
};
for(const [oldName,newName] of Object.entries(categoryNames)){
  const next=getCat.get(newName),old=getCat.get(oldName);
  if(!next||!old||next.id===old.id)continue;
  db.prepare('UPDATE products SET category=?,category_id=? WHERE category_id=? OR category=?').run(newName,next.id,old.id,oldName);
  db.prepare('DELETE FROM categories WHERE id=?').run(old.id);
}
for(const product of db.prepare('SELECT id,name,category FROM products').all()){
  const name=product.name==='Hollandia'&&product.category==='Drinks'
    ? 'Hollandia Yoghurt'
    : nameAliases[product.name]||product.name;
  const category=productCategory[name]||categoryNames[product.category]||product.category;
  const cat=getCat.get(category);
  if(cat&&(name!==product.name||category!==product.category)) {
    db.prepare('UPDATE products SET name=?,category=?,category_id=? WHERE id=?').run(name,category,cat.id,product.id);
    if(name!==product.name){
      const description=db.prepare('SELECT description FROM products WHERE id=?').get(product.id).description;
      const oldPrefix=product.name+' — ';
      if(description?.startsWith(oldPrefix))db.prepare('UPDATE products SET description=? WHERE id=?').run(name+description.slice(product.name.length),product.id);
    }
  }
}
const legacyDescriptions=[
  ['farashin guda; za a iya saita farashin carton daga Admin.','unit price; carton pricing can be set in Admin.'],
  ['an shigar da farashin da aka bayar; za a iya gyara guda/carton a Admin.','provided price; unit and carton prices can be adjusted in Admin.'],
  ['farashin da aka bayar; za a iya gyara guda/carton a Admin.','provided price; unit and carton prices can be adjusted in Admin.'],
  ['farashin da aka bayar; za a iya saita farashin carton daga Admin.','provided price; carton pricing can be set in Admin.']
];
const updateDescription=db.prepare('UPDATE products SET description=? WHERE id=?');
for(const product of db.prepare('SELECT id,description FROM products WHERE description IS NOT NULL').all()){
  let description=product.description;
  for(const [oldText,newText] of legacyDescriptions) description=description.replace(oldText,newText);
  if(description!==product.description) updateDescription.run(description,product.id);
}
const slug=value=>String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const imagePath=p=>`/assets/products/${slug(p.category)}/${slug(p.name)}.svg`;
const description=p=>{
  if(p.category.includes('Clothing'))return `A modern ${p.name} style selected for our ${p.category.toLowerCase()} collection.`;
  if(p.category==='Sewing Materials')return `${p.name} for sewing, tailoring, and creative projects.`;
  return `${p.name} from our ${p.category.toLowerCase()} range.`;
};
const find=db.prepare('SELECT id,image FROM products WHERE name=? AND category=? ORDER BY id LIMIT 1');
const ins=db.prepare('INSERT INTO products(name,sku,description,category,price,discount,stock,active,image,created,updated,carton_price,carton_qty,size,category_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
for(const p of catalog.products){
  const c=getCat.get(p.category),old=find.get(p.name,p.category);
  if(!old&&!p.legacy)ins.run(p.name,null,p.description||description(p),p.category,p.price,0,p.stock||100,1,imagePath(p),now(),now(),null,null,p.size||null,c.id);
  else if(old&&!old.image)db.prepare('UPDATE products SET image=? WHERE id=?').run(imagePath(p),old.id);
}
console.log(`Catalog ready: ${catalog.products.length} catalog entries in ${catalog.categories.length} categories.`);
