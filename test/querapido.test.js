import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andra-qr-'));
process.env.ANDRA_DB = path.join(dir, 't.db');
const { openDb } = await import('../src/db.js');
const { applySnapshot } = await import('../src/sync.js');
const { decodeEntities, normalizeQrProduct } = await import('../src/scraper/querapido.js');
const { SOURCES } = await import('../src/sources.js');

const T = SOURCES.qr.T;
const db = openDb();
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const cats = [
  { id: 1, parentId: null, name: 'Informática', url: 'u', level: 0, path: 'Informática' },
  { id: 2, parentId: 1, name: 'Monitores', url: 'u', level: 1, path: 'Informática › Monitores' },
];
const byId = new Map(cats.map((c) => [c.id, c]));
const api = (id, { price = 1000, regular = price, inStock = true, backorder = false } = {}) => ({
  id, name: `Monitor &#8220;${id}&#8221;`, slug: `m${id}`, permalink: `https://x/m${id}/`, sku: `S${id}`,
  prices: { price: String(price), regular_price: String(regular), currency_minor_unit: 0 },
  is_in_stock: inStock, is_on_backorder: backorder, categories: [{ id: 2 }], brands: [{ id: 9, name: 'Lenovo' }],
});
let run = 0;
function sync(list) {
  run = db.prepare(`INSERT INTO ${T.runs} (started_at) VALUES (?)`).run(new Date().toISOString()).lastInsertRowid;
  const products = list.map((p) => normalizeQrProduct(p, byId, null));
  applySnapshot(db, run, { categories: cats, products, stores: [], complete: true, remoteTotal: list.length }, undefined, T);
  return db.prepare(`SELECT type, note FROM ${T.events} WHERE run_id=?`).all(run);
}

test('converte entidades HTML dos nomes', () => {
  assert.equal(decodeEntities('Placa &#8220;Blackwell&#8221; 6.9&#8243; &amp; mais'), 'Placa “Blackwell” 6.9″ & mais');
});

test('normaliza preço, promoção, categorias com ascendentes e estado do stock', () => {
  const p = normalizeQrProduct(api(5, { price: 800, regular: 1000, backorder: true }), byId, null);
  assert.equal(p.skus[0].price, 800);
  assert.equal(p.skus[0].discountPct, 20);
  assert.equal(p.skus[0].onPromo, 1);
  assert.equal(p.skus[0].availability, 'backorder');
  assert.equal(p.skus[0].isAvailable, 1);
  assert.deepEqual(p.categoryIds.sort(), [1, 2]);
  assert.equal(p.categoryId, 2);
  assert.equal(p.brandName, 'Lenovo');
});

test('guarda nas tabelas da Que Rápido sem tocar nas da NCR', () => {
  sync([api(1), api(2)]);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${T.products}`).get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM products').get().c, 0);
});

test('regista mudanças de estado do stock sem quantidade', () => {
  assert.deepEqual(sync([api(1, { inStock: false }), api(2, { backorder: true })]).map((e) => e.type).sort(), ['out_of_stock', 'to_backorder']);
  assert.deepEqual(sync([api(1), api(2)]).map((e) => e.type).sort(), ['back_in_stock', 'from_backorder']);
  assert.equal(sync([api(1), api(2)]).length, 0);
});

test('mantém a imagem quando a recolha seguinte não a traz', () => {
  db.prepare(`UPDATE ${T.products} SET image_url='https://x/i.webp' WHERE id=1`).run();
  sync([api(1), api(2)]);
  assert.equal(db.prepare(`SELECT image_url FROM ${T.products} WHERE id=1`).get().image_url, 'https://x/i.webp');
});
