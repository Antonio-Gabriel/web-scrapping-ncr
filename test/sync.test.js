import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'andra-'));
process.env.ANDRA_DB = path.join(dir, 't.db');
const { openDb } = await import('../src/db.js');
const { applySnapshot } = await import('../src/sync.js');
const { applyStock, normalizeProduct } = await import('../src/scraper/catalog.js');

const db = openDb();
after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const raw = (id, { price = 100, list = price, qty = 10 } = {}) => ({
  productId: String(id), productName: `P${id}`, brandId: 1, brand: 'B', categoryId: '2', categoriesIds: ['/1/2/', '/1/'],
  linkText: `p${id}`, link: `https://x/p${id}/p`, productClusters: {}, allSpecifications: [],
  items: [{ itemId: String(id), images: [], sellers: [{ sellerDefault: true, sellerName: 'S', commertialOffer: { Price: price, ListPrice: list, AvailableQuantity: qty, IsAvailable: true } }] }],
});
const categories = [{ id: 1, parentId: null, name: 'A', url: 'u', level: 0, path: 'A' }, { id: 2, parentId: 1, name: 'B', url: 'u', level: 1, path: 'A › B' }];

function sync(items, { complete = true } = {}) {
  const runId = db.prepare(`INSERT INTO runs (started_at) VALUES (?)`).run(new Date().toISOString()).lastInsertRowid;
  const stock = new Map(items.filter(([, o]) => o.real != null).map(([id, o]) => [id, o.real]));
  const products = applyStock(items.map(([id, o]) => normalizeProduct(raw(id, o))), stock);
  const r = applySnapshot(db, runId, { categories, products, stores: [], complete, remoteTotal: items.length });
  return { ...r, events: db.prepare(`SELECT type, product_id, old_value, new_value, delta, note FROM events WHERE run_id=?`).all(runId) };
}
const seed = Array.from({ length: 10 }, (_, i) => [i + 1, { real: 8 }]);
const withOverride = (id, o) => seed.map(([k, v]) => (k === id ? [k, { ...v, ...o }] : [k, v]));

test('carga inicial não gera eventos de produto novo', () => {
  const r = sync(seed);
  assert.equal(r.isBaseline, true);
  assert.equal(r.events.length, 0);
});

test('sem alterações não gera eventos', () => assert.equal(sync(seed).events.length, 0));

test('deteta redução de stock com a diferença correta', () => {
  const r = sync(withOverride(1, { real: 3 }));
  assert.deepEqual(r.events.map((e) => [e.type, e.product_id, e.delta]), [['stock_down', 1, -5]]);
  sync(seed);
});

test('de 50+ para exato regista redução mínima', () => {
  sync(withOverride(2, { real: 50 }));
  const r = sync(withOverride(2, { real: 20 }));
  assert.equal(r.events[0].type, 'stock_down');
  assert.equal(r.events[0].note, 'pelo menos');
  sync(seed);
});

test('falha na leitura de stock preserva o valor e não inventa alterações', () => {
  const r = sync(seed.map(([k]) => [k, {}]));
  assert.equal(r.events.length, 0);
  assert.equal(db.prepare(`SELECT available_qty q FROM skus WHERE id=1`).get().q, 8);
});

test('esgotado e reposição', () => {
  assert.equal(sync(withOverride(3, { real: 0 })).events[0].type, 'out_of_stock');
  assert.equal(sync(seed).events[0].type, 'back_in_stock');
});

test('deteta produto novo', () => {
  const r = sync([...seed, [11, { real: 5 }]]);
  assert.ok(r.events.some((e) => e.type === 'new_product' && e.product_id === 11));
});

test('preço e início de promoção', () => {
  const r = sync(withOverride(4, { price: 80, list: 100 }).concat([[11, { real: 5 }]]));
  const t = r.events.map((e) => e.type);
  assert.ok(t.includes('price_down') && t.includes('promo_start'));
  assert.equal(db.prepare(`SELECT discount_pct d FROM skus WHERE id=4`).get().d, 20);
  sync(seed.concat([[11, { real: 5 }]]));
});

test('recolha parcial nunca marca remoções', () => {
  const r = sync(seed.slice(0, 3), { complete: false });
  assert.equal(r.removed, 0);
});

test('recolha com cobertura baixa não marca remoções em massa', () => {
  assert.equal(sync(seed.slice(0, 3)).removed, 0);
});

test('produto que sai numa recolha completa é removido e pode reaparecer', () => {
  const r = sync(seed);
  assert.deepEqual(r.events.filter((e) => e.type === 'removed').map((e) => e.product_id), [11]);
  assert.equal(db.prepare(`SELECT active a FROM products WHERE id=11`).get().a, 0);
  const back = sync([...seed, [11, { real: 5 }]]);
  assert.ok(back.events.some((e) => e.type === 'reappeared'));
  assert.equal(db.prepare(`SELECT active a FROM skus WHERE id=11`).get().a, 1);
});
