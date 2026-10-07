'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createDatabase } = require('./database');
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
const now = () => new Date().toISOString();

const categoryNames = {
  'Soft Drinks': 'Drinks',
  'Dairy Drinks': 'Drinks',
  Juices: 'Juice',
  'Water & Beverages': 'Water',
  'Clothes (Riguna)': "Women's Clothing",
  'Maza – Maza (Babbar Rigar / Ƙaramar Riga / Jamfa / Jallabiya)': "Men's Clothing",
  'Mata – Mata (Riguna / Hijabi / Kayan Ɗinki)': "Women's Clothing",
  'Jarirai da Yara – Baby & Kids': 'Children\'s Clothing'
};
const nameAliases = {
  'Coca Cola': 'Coca-Cola',
  'Nutri-milk': 'Nutri-Milk',
  Lacasera: 'La Casera',
  '5Alive Big & Small': '5 Alive'
};
const productCategory = {
  'Mr V': 'Water',
  Peach: 'Juice',
  Predator: 'Energy Drinks',
  Yugo: 'Drinks'
};
const legacyDescriptions = [
  ['farashin guda; za a iya saita farashin carton daga Admin.', 'unit price; carton pricing can be set in Admin.'],
  ['an shigar da farashin da aka bayar; za a iya gyara guda/carton a Admin.', 'provided price; unit and carton prices can be adjusted in Admin.'],
  ['farashin da aka bayar; za a iya gyara guda/carton a Admin.', 'provided price; unit and carton prices can be adjusted in Admin.'],
  ['farashin da aka bayar; za a iya saita farashin carton daga Admin.', 'provided price; carton pricing can be set in Admin.']
];
const slug = value => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const imagePath = product => `/assets/products/${slug(product.category)}/${slug(product.name)}.svg`;
const description = product => {
  if (product.category.includes('Clothing')) return `A modern ${product.name} style selected for our ${product.category.toLowerCase()} collection.`;
  if (product.category === 'Sewing Materials') return `${product.name} for sewing, tailoring, and creative projects.`;
  return `${product.name} from our ${product.category.toLowerCase()} range.`;
};

async function seedCatalog() {
  const db = await createDatabase();
  try {
    const getCategory = name => db.get('SELECT id FROM categories WHERE name=?', name);
    for (const name of catalog.categories) await db.run('INSERT OR IGNORE INTO categories(name) VALUES(?)', name);

    for (const [oldName, newName] of Object.entries(categoryNames)) {
      const next = await getCategory(newName), old = await getCategory(oldName);
      if (!next || !old || next.id === old.id) continue;
      await db.run('UPDATE products SET category=?,category_id=? WHERE category_id=? OR category=?', newName, next.id, old.id, oldName);
      await db.run('DELETE FROM categories WHERE id=?', old.id);
    }

    for (const product of await db.all('SELECT id,name,category FROM products')) {
      const name = product.name === 'Hollandia' && product.category === 'Drinks'
        ? 'Hollandia Yoghurt'
        : nameAliases[product.name] || product.name;
      const category = productCategory[name] || categoryNames[product.category] || product.category;
      const cat = await getCategory(category);
      if (cat && (name !== product.name || category !== product.category)) {
        await db.run('UPDATE products SET name=?,category=?,category_id=? WHERE id=?', name, category, cat.id, product.id);
        if (name !== product.name) {
          const current = await db.get('SELECT description FROM products WHERE id=?', product.id);
          const oldPrefix = product.name + ' — ';
          if (current.description?.startsWith(oldPrefix))
            await db.run('UPDATE products SET description=? WHERE id=?', name + current.description.slice(product.name.length), product.id);
        }
      }
    }

    for (const product of await db.all('SELECT id,description FROM products WHERE description IS NOT NULL')) {
      let text = product.description;
      for (const [oldText, newText] of legacyDescriptions) text = text.replace(oldText, newText);
      if (text !== product.description) await db.run('UPDATE products SET description=? WHERE id=?', text, product.id);
    }

    for (const product of catalog.products) {
      const category = await getCategory(product.category);
      const old = await db.get('SELECT id,image FROM products WHERE name=? AND category=? ORDER BY id LIMIT 1', product.name, product.category);
      if (!old && !product.legacy) {
        await db.run('INSERT INTO products(name,sku,description,category,price,discount,stock,active,image,created,updated,carton_price,carton_qty,size,category_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          product.name, null, product.description || description(product), product.category, product.price, 0, product.stock || 100, 1, imagePath(product), now(), now(), null, null, product.size || null, category.id);
      } else if (old && !old.image) {
        await db.run('UPDATE products SET image=? WHERE id=?', imagePath(product), old.id);
      }
    }
    console.log(`Catalog ready: ${catalog.products.length} catalog entries in ${catalog.categories.length} categories.`);
  } finally {
    await db.close();
  }
}

seedCatalog().catch(error => {
  console.error('Catalog seeding failed:', error);
  process.exitCode = 1;
});
