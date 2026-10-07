'use strict';

const fs = require('fs');
const path = require('path');
const catalog = require('../catalog.json');
const root = path.join(__dirname, '..', 'public', 'assets', 'products');

const slug = value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const hash = value => [...value].reduce((n, c) => ((n * 31) + c.charCodeAt(0)) >>> 0, 7);
const colors = ['#d35432', '#126b59', '#234f92', '#8b4c91', '#bd782b', '#305a6e', '#a5364d', '#587436'];

function art(product) {
  const color = colors[hash(product.category + product.name) % colors.length];
  const name = esc(product.name);
  const small = product.name.length > 17 ? 19 : 24;
  let illustration;
  if (product.category === "Women's Clothing" || product.category === "Men's Clothing" || product.category === "Children's Clothing") {
    const child = product.category === "Children's Clothing";
    const woman = product.category === "Women's Clothing";
    const isAccessory = /hijab|cap|turban|sandals/i.test(product.name);
    const isBottom = /jeans|trousers|shorts|joggers/i.test(product.name);
    const isSet = /two-piece|tracksuit|skirt/i.test(product.name);
    let garment;
    if (isAccessory) {
      garment = /sandals/i.test(product.name)
        ? '<path d="M170 267h44l10 75h-52zM255 267h44l10 75h-52z" fill="#d3a47f"/><path d="M175 303h42M260 303h42" stroke="#fff" stroke-width="8" stroke-linecap="round"/>'
        : '<path d="M176 160q5-62 56-62t56 62q-35-22-112 0z" fill="currentColor"/>';
    } else if (isBottom) {
      garment = '<path d="M183 177h120l-9 162h-43l-8-104-8 104h-43z" fill="currentColor"/>';
    } else if (isSet) {
      garment = '<path d="M204 113l-39 20 18 67 17-8v82h91v-82l17 8 18-67-39-20-24 27h-34z" fill="currentColor"/><path d="M201 266l-8 77h46l8-60 8 60h46l-8-77z" fill="#d4ae91"/>';
    } else {
      const hem = woman ? (child ? 290 : 280) : 240;
      garment = `<path d="M204 113l-39 20 18 67 17-8v${hem - 80}h91v-${hem - 80}l17 8 18-67-39-20-24 27h-34z" fill="currentColor"/><path d="M200 ${hem - 80}h99l${woman ? '18 105h-135z' : '6 75h-111z'}" fill="currentColor"/>`;
    }
    illustration = `<g color="${color}"><circle cx="240" cy="94" r="30" fill="#b97c5b"/><path d="M206 91q3-41 35-41 35 0 35 42l-11-12-3-16q-22 16-51 12z" fill="#302820"/><path d="M213 122q26-18 53 0l26 66-15 15-12-26v44h-79v-44l-12 26-15-15z" fill="#d4ae91"/>${garment}</g>`;
  } else if (product.category === 'Sewing Materials') {
    if (/scissors/i.test(product.name)) illustration = `<g fill="none" stroke="${color}" stroke-width="13"><circle cx="188" cy="254" r="35"/><circle cx="188" cy="329" r="35"/><path d="M211 270l110-150M211 313l110 150M200 280l30 12"/></g>`;
    else if (/needle|pin/i.test(product.name)) illustration = `<g transform="rotate(35 240 275)"><path d="M240 105v330" stroke="${color}" stroke-width="13" stroke-linecap="round"/><ellipse cx="240" cy="107" rx="15" ry="25" fill="none" stroke="${color}" stroke-width="9"/><path d="M218 335h44v65h-44z" fill="#d7b790"/></g>`;
    else if (/tape|thread|bobbin|elastic/i.test(product.name)) illustration = `<circle cx="240" cy="265" r="112" fill="${color}"/><circle cx="240" cy="265" r="38" fill="#f8f4ec"/><path d="M190 185q40-34 90 0M178 240q62-40 124 0M184 302q56 34 112 0" fill="none" stroke="#f8f4ec" stroke-width="8" stroke-linecap="round"/>`;
    else if (/zipper/i.test(product.name)) illustration = `<path d="M240 105v330" stroke="${color}" stroke-width="20"/><path d="M212 140h56m-56 38h56m-56 38h56m-56 38h56m-56 38h56m-56 38h56" stroke="#e9c98d" stroke-width="12"/><path d="M225 248h30l-5 47h-20z" fill="#b38a57"/>`;
    else if (/chalk/i.test(product.name)) illustration = `<path d="M180 378l85-253q7-21 25-15t11 27l-85 253q-7 20-25 14t-11-26z" fill="#f1e4bd"/><path d="M257 154l44 15" stroke="#e8d5a6" stroke-width="10"/>`;
    else if (/bead|button|sequin/i.test(product.name)) illustration = `<g fill="${color}"><circle cx="183" cy="196" r="35"/><circle cx="260" cy="174" r="35"/><circle cx="318" cy="230" r="35"/><circle cx="210" cy="278" r="35"/><circle cx="292" cy="322" r="35"/><circle cx="170" cy="360" r="27"/></g><g fill="#f8f4ec"><circle cx="183" cy="196" r="8"/><circle cx="260" cy="174" r="8"/><circle cx="318" cy="230" r="8"/><circle cx="210" cy="278" r="8"/><circle cx="292" cy="322" r="8"/></g>`;
    else illustration = `<path d="M188 165h104l-17 210h-70z" fill="${color}"/><path d="M207 195h66m-70 40h74m-78 40h82m-87 40h92" stroke="#f3dfbc" stroke-width="8"/>`;
  } else {
    const water = product.category === 'Water';
    const energy = product.category === 'Energy Drinks';
    const juice = product.category === 'Juice';
    const bottle = water || /milk|yoghurt|juice|ribena|viju/i.test(product.name);
    illustration = bottle
      ? `<path d="M216 105h48v40l24 31v176q0 30-30 30h-36q-30 0-30-30V176l24-31z" fill="#fff" stroke="${color}" stroke-width="10"/><path d="M216 105h48v36h-48z" fill="${color}"/><path d="M202 219h76v82h-76z" fill="${water ? '#b9dceb' : color}"/><text x="240" y="252" text-anchor="middle" fill="${water ? '#164f67' : '#fff'}" font-size="17" font-weight="700">${name.length > 15 ? esc(product.name.slice(0, 13)) : name}</text>`
      : `<rect x="174" y="116" width="132" height="282" rx="${energy ? 30 : 20}" fill="${color}"/><rect x="184" y="128" width="112" height="16" rx="8" fill="#fff" opacity=".75"/><path d="M181 320h118v54q0 15-15 15h-88q-15 0-15-15z" fill="#fff" opacity=".15"/><text x="240" y="247" text-anchor="middle" fill="#fff" font-size="${small}" font-weight="700">${name.length > 15 ? esc(product.name.slice(0, 13)) : name}</text><path d="M224 268l20-34 12 24 18-8-26 43-10-24z" fill="#f8db75"/>`;
    if (juice) illustration += '<circle cx="309" cy="325" r="24" fill="#e78b37"/><path d="M299 301q7-23 27-20" fill="none" stroke="#547f45" stroke-width="7"/>';
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="600" viewBox="0 0 480 600" role="img" aria-labelledby="title"><title id="title">${name} product illustration</title><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#faf7f1"/><stop offset="1" stop-color="#e9e2d5"/></linearGradient><filter id="shadow" x="-.2" y="-.2" width="1.4" height="1.5"><feDropShadow dx="0" dy="12" stdDeviation="12" flood-color="#26302c" flood-opacity=".14"/></filter></defs><rect width="480" height="600" rx="34" fill="url(#bg)"/><circle cx="240" cy="270" r="165" fill="#fff" opacity=".55"/><g filter="url(#shadow)">${illustration}</g><rect x="24" y="468" width="432" height="104" rx="18" fill="#fff" opacity=".94"/><text x="240" y="510" text-anchor="middle" fill="#26302c" font-family="Arial,sans-serif" font-size="${small}" font-weight="700">${name}</text><text x="240" y="544" text-anchor="middle" fill="#68716c" font-family="Arial,sans-serif" font-size="15">Original product illustration · Replaceable in Admin</text><text x="240" y="40" text-anchor="middle" fill="${color}" font-family="Arial,sans-serif" font-size="14" font-weight="700" letter-spacing="2">${esc(product.category.toUpperCase())}</text></svg>`;
}

for (const product of catalog.products) {
  const directory = path.join(root, slug(product.category));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${slug(product.name)}.svg`), art(product));
}
console.log(`Generated ${catalog.products.length} original product illustrations.`);
