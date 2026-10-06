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
for(const name of catalog.categories) db.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)').run(name);
const getCat=db.prepare('SELECT id FROM categories WHERE name=?');
const find=db.prepare('SELECT id FROM products WHERE name=?');
const ins=db.prepare('INSERT INTO products(name,sku,description,category,price,discount,stock,active,image,created,updated,carton_price,carton_qty,size,category_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
for(const p of catalog.products){const c=getCat.get(p.category);const old=find.get(p.name);if(!old) ins.run(p.name,null,p.description,p.category,p.price,0,p.stock,1,null,now(),now(),null,null,p.size||null,c.id);}
console.log(`Catalog ready: ${catalog.products.length} products in ${catalog.categories.length} categories.`);
