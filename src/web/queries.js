import { config } from '../config.js';

const LOW = config.lowStockAt;
const CATALOG_FROM = `FROM products p JOIN skus s ON s.product_id=p.id
  LEFT JOIN brands b ON b.id=p.brand_id LEFT JOIN categories c ON c.id=p.category_id`;
const CATALOG_SELECT = `SELECT p.id, p.name, p.slug, p.url, p.image_url, p.active, p.first_seen, p.reference, p.removed_at,
  b.name brand, c.name category, c.path category_path, s.id sku_id, s.price, s.list_price, s.discount_pct, s.on_promo,
  s.available_qty, s.stock_known, s.is_available ${CATALOG_FROM}`;
const LOW_SQL = `s.is_available=1 AND s.stock_known=1 AND s.available_qty<=${LOW}`;

export const STATUS_FILTERS = {
  all: { label: 'Todos', sql: 'p.active=1' },
  available: { label: 'Disponíveis', sql: 'p.active=1 AND s.is_available=1' },
  promo: { label: 'Em promoção', sql: 'p.active=1 AND s.on_promo=1' },
  low: { label: `Stock baixo (até ${LOW})`, sql: `p.active=1 AND ${LOW_SQL}` },
  out: { label: 'Esgotados', sql: 'p.active=1 AND s.is_available=0' },
  removed: { label: 'Fora do catálogo', sql: 'p.active=0' },
};
const SORTS = {
  name: 'p.name COLLATE NOCASE', price: 's.price', discount: 's.discount_pct', stock: 's.available_qty',
  brand: 'b.name COLLATE NOCASE', recent: 'p.first_seen',
};
const like = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;
const medianOf = (values) => {
  const a = values.filter((v) => v > 0).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

function filterSql(f) {
  const where = []; const params = {};
  if (f.q) {
    where.push(`(p.name LIKE @q ESCAPE '\\' OR p.reference LIKE @q ESCAPE '\\' OR b.name LIKE @q ESCAPE '\\' OR s.ean = @exact)`);
    params.q = like(f.q); params.exact = f.q;
  }
  if (f.category) { where.push(`p.id IN (SELECT product_id FROM product_categories WHERE category_id=@category)`); params.category = f.category; }
  if (f.brand) { where.push('p.brand_id=@brand'); params.brand = f.brand; }
  return { where, params };
}

export function listProducts(db, f) {
  const { where, params } = filterSql(f);
  const status = STATUS_FILTERS[f.status] ? f.status : 'all';
  const sql = [...where, STATUS_FILTERS[status].sql].join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c ${CATALOG_FROM} WHERE ${sql}`).get(params).c;
  const sort = SORTS[f.sort] || SORTS.name;
  const dir = f.dir === 'desc' ? 'DESC' : 'ASC';
  const limit = f.limit ?? 25;
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(1, f.page || 1), pages);
  const rows = db.prepare(`${CATALOG_SELECT} WHERE ${sql} ORDER BY ${sort} ${dir}, p.id LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset: (page - 1) * limit });
  const base = where.length ? `${where.join(' AND ')} AND ` : '';
  const counts = Object.entries(STATUS_FILTERS).map(([key, s]) => ({
    key, label: s.label, active: key === status,
    count: db.prepare(`SELECT COUNT(*) c ${CATALOG_FROM} WHERE ${base}${s.sql}`).get(params).c,
  }));
  return { rows, total, page, pages, limit, status, counts, from: total ? (page - 1) * limit + 1 : 0, to: Math.min(page * limit, total) };
}

export const filterOptions = (db) => ({
  departments: db.prepare(`SELECT c.id, c.path name FROM categories c
    WHERE EXISTS (SELECT 1 FROM product_categories pc JOIN products p ON p.id=pc.product_id WHERE pc.category_id=c.id AND p.active=1) ORDER BY c.path`).all(),
  brands: db.prepare(`SELECT b.id, b.name FROM brands b WHERE EXISTS (SELECT 1 FROM products p WHERE p.brand_id=b.id AND p.active=1) ORDER BY b.name COLLATE NOCASE`).all(),
});

export function productDetail(db, id) {
  const product = db.prepare(`${CATALOG_SELECT} WHERE p.id=? LIMIT 1`).get(id);
  if (!product) return null;
  const extra = db.prepare(`SELECT description, specs, release_date FROM products WHERE id=?`).get(id);
  const hist = (table) => db.prepare(`SELECT * FROM ${table} WHERE sku_id=? ORDER BY at`).all(product.sku_id);
  return {
    product: { ...product, ...extra },
    specs: extra.specs ? Object.entries(JSON.parse(extra.specs)).map(([k, v]) => ({ k, v })) : [],
    prices: hist('price_history'), stock: hist('stock_history'),
    events: db.prepare(`SELECT * FROM events WHERE product_id=? ORDER BY at DESC, id DESC LIMIT 50`).all(id),
    clusters: db.prepare(`SELECT c.name FROM product_clusters pc JOIN clusters c ON c.id=pc.cluster_id WHERE pc.product_id=? AND c.name<>'egoi' ORDER BY c.name`).all(id).map((c) => c.name),
  };
}

export function categoryTree(db) {
  const rows = db.prepare(`SELECT c.id, c.parent_id, c.name, c.url, c.level,
      COUNT(s.id) products, AVG(s.price) avg_price, SUM(s.on_promo) promos,
      SUM(CASE WHEN ${LOW_SQL} THEN 1 ELSE 0 END) low
    FROM categories c
    LEFT JOIN product_categories pc ON pc.category_id=c.id
    LEFT JOIN products p ON p.id=pc.product_id AND p.active=1
    LEFT JOIN skus s ON s.product_id=p.id AND s.active=1
    WHERE c.active=1 GROUP BY c.id ORDER BY products DESC, c.name`).all();
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const n of byId.values()) (n.parent_id && byId.get(n.parent_id)?.children || roots).push(n);
  const prune = (list) => list.filter((n) => n.products > 0).map((n) => ({ ...n, children: prune(n.children) }));
  return { roots: prune(roots), total: rows.length, withProducts: rows.filter((r) => r.products > 0).length };
}

const departmentRows = (db) => db.prepare(`SELECT c.id, c.name, s.price, s.on_promo, s.discount_pct, s.available_qty
  FROM categories c JOIN product_categories pc ON pc.category_id=c.id JOIN products p ON p.id=pc.product_id AND p.active=1
  JOIN skus s ON s.product_id=p.id AND s.active=1 WHERE c.level=0`).all();

export function departments(db) {
  const map = new Map();
  for (const r of departmentRows(db)) {
    const d = map.get(r.id) || { id: r.id, name: r.name, products: 0, promos: 0, prices: [], stockValue: 0 };
    d.products++; d.promos += r.on_promo; d.prices.push(r.price);
    d.stockValue += (r.price || 0) * (r.available_qty || 0);
    map.set(r.id, d);
  }
  return [...map.values()].map((d) => ({
    ...d, median: medianOf(d.prices), promoRate: d.products ? d.promos / d.products * 100 : 0, prices: undefined,
  }));
}

export function summary(db) {
  const row = db.prepare(`SELECT COUNT(DISTINCT p.id) products, COUNT(*) skus, SUM(s.on_promo) promos,
      AVG(CASE WHEN s.on_promo=1 THEN s.discount_pct END) avg_discount, MAX(s.discount_pct) max_discount,
      SUM(CASE WHEN s.on_promo=1 THEN s.list_price-s.price ELSE 0 END) total_saving,
      SUM(CASE WHEN s.is_available=0 THEN 1 ELSE 0 END) out_of_stock,
      SUM(CASE WHEN ${LOW_SQL} THEN 1 ELSE 0 END) low_stock,
      SUM(CASE WHEN s.is_available=1 AND s.stock_known=0 THEN 1 ELSE 0 END) capped,
      SUM(CASE WHEN s.is_available=1 AND s.stock_known=1 AND s.available_qty>${LOW} THEN 1 ELSE 0 END) mid_stock,
      AVG(s.price) avg_price, SUM(s.price*COALESCE(s.available_qty,0)) stock_value,
      SUM(COALESCE(s.available_qty,0)) units
    FROM products p JOIN skus s ON s.product_id=p.id WHERE p.active=1`).get();
  return {
    ...row,
    median_price: medianOf(db.prepare(`SELECT s.price FROM skus s WHERE s.active=1`).all().map((s) => s.price)),
    categories: db.prepare(`SELECT COUNT(DISTINCT pc.category_id) c FROM product_categories pc JOIN products p ON p.id=pc.product_id AND p.active=1`).get().c,
    brands: db.prepare(`SELECT COUNT(DISTINCT brand_id) c FROM products WHERE active=1`).get().c,
    stores: db.prepare(`SELECT COUNT(*) c FROM stores WHERE active=1 AND source='nossas-lojas'`).get().c,
    pickup: db.prepare(`SELECT COUNT(*) c FROM stores WHERE active=1 AND source<>'nossas-lojas'`).get().c,
  };
}

export const EVENT_GROUPS = {
  all: { label: 'Tudo', types: null },
  reductions: { label: 'Reduções de stock', types: ['stock_down', 'out_of_stock', 'removed'] },
  increases: { label: 'Reposições', types: ['stock_up', 'back_in_stock', 'reappeared'] },
  new: { label: 'Produtos novos', types: ['new_product'] },
  price: { label: 'Preços', types: ['price_up', 'price_down'] },
  promo: { label: 'Promoções', types: ['promo_start', 'promo_end'] },
};

export function listEvents(db, { group = 'all', page = 1, limit = 30 } = {}) {
  const g = EVENT_GROUPS[group] ? group : 'all';
  const types = EVENT_GROUPS[g].types;
  const where = types ? `WHERE e.type IN (${types.map(() => '?').join(',')})` : '';
  const args = types || [];
  const total = db.prepare(`SELECT COUNT(*) c FROM events e ${where}`).get(...args).c;
  const pages = Math.max(1, Math.ceil(total / limit));
  const p = Math.min(Math.max(1, page), pages);
  const rows = db.prepare(`SELECT e.*, pr.name product_name, pr.image_url FROM events e JOIN products pr ON pr.id=e.product_id ${where}
    ORDER BY e.at DESC, e.id DESC LIMIT ? OFFSET ?`).all(...args, limit, (p - 1) * limit);
  const counts = Object.entries(EVENT_GROUPS).map(([key, v]) => ({
    key, label: v.label, active: key === g,
    count: v.types
      ? db.prepare(`SELECT COUNT(*) c FROM events WHERE type IN (${v.types.map(() => '?').join(',')})`).get(...v.types).c
      : db.prepare(`SELECT COUNT(*) c FROM events`).get().c,
  }));
  return { rows, total, page: p, pages, group: g, counts, from: total ? (p - 1) * limit + 1 : 0, to: Math.min(p * limit, total) };
}

export const eventsSince = (db, hours) => db.prepare(`SELECT
    SUM(type IN ('stock_down','out_of_stock','removed')) reductions, SUM(type='new_product') new_products,
    SUM(type IN ('price_up','price_down')) price_changes, SUM(type IN ('promo_start','promo_end')) promo_changes
  FROM events WHERE at >= ?`).get(new Date(Date.now() - hours * 3600_000).toISOString());

export const lowStock = (db, limit = 10) => db.prepare(`${CATALOG_SELECT} WHERE p.active=1 AND ${LOW_SQL}
  ORDER BY s.available_qty, s.price DESC LIMIT ?`).all(limit);

export const topPromos = (db, limit = 6) => db.prepare(`${CATALOG_SELECT} WHERE p.active=1 AND s.on_promo=1
  ORDER BY s.discount_pct DESC LIMIT ?`).all(limit);

export const campaigns = (db) => {
  const active = db.prepare(`SELECT COUNT(*) c FROM products WHERE active=1`).get().c;
  // Coleções que cobrem quase todo o catálogo são técnicas (ex.: marketing), não campanhas.
  return db.prepare(`SELECT c.id, c.name, COUNT(*) products, SUM(s.on_promo) promos, AVG(CASE WHEN s.on_promo=1 THEN s.discount_pct END) avg_discount
    FROM clusters c JOIN product_clusters pc ON pc.cluster_id=c.id JOIN products p ON p.id=pc.product_id AND p.active=1
    JOIN skus s ON s.product_id=p.id GROUP BY c.id HAVING products < ? ORDER BY promos DESC, products DESC`).all(active * 0.5);
};

export const stores = (db) => db.prepare(`SELECT * FROM stores WHERE active=1 ORDER BY source='pickup-points', city, name`).all();

export const brandRanking = (db, limit = 10) => db.prepare(`SELECT b.id, b.name, COUNT(*) products, SUM(s.price*COALESCE(s.available_qty,0)) stock_value
  FROM products p JOIN skus s ON s.product_id=p.id JOIN brands b ON b.id=p.brand_id WHERE p.active=1
  GROUP BY b.id ORDER BY products DESC LIMIT ?`).all(limit);

const PRICE_BANDS = [
  ['< 5 mil', 0, 5e3], ['5–25 mil', 5e3, 25e3], ['25–100 mil', 25e3, 1e5],
  ['100–500 mil', 1e5, 5e5], ['500 mil–1 M', 5e5, 1e6], ['> 1 M', 1e6, Infinity],
];
const DISCOUNT_BANDS = [['Até 5%', 0, 5], ['5–10%', 5, 10], ['10–20%', 10, 20], ['20–30%', 20, 30], ['Mais de 30%', 30, Infinity]];
const bandCounts = (values, bands) => bands.map(([label, lo, hi]) => ({ label, value: values.filter((v) => v >= lo && v < hi).length }));

export const priceBands = (db) => bandCounts(db.prepare(`SELECT price v FROM skus WHERE active=1 AND price>0`).all().map((r) => r.v), PRICE_BANDS);
export const discountBands = (db) => bandCounts(db.prepare(`SELECT discount_pct v FROM skus WHERE active=1 AND on_promo=1`).all().map((r) => r.v), DISCOUNT_BANDS);

export const priceExtremes = (db, limit = 6) => ({
  highest: db.prepare(`${CATALOG_SELECT} WHERE p.active=1 ORDER BY s.price DESC LIMIT ?`).all(limit),
  lowest: db.prepare(`${CATALOG_SELECT} WHERE p.active=1 AND s.price>0 ORDER BY s.price ASC LIMIT ?`).all(limit),
});

export const topMovers = (db, limit = 10) => db.prepare(`SELECT e.product_id id, p.name, p.image_url, COUNT(*) reductions,
    SUM(-e.delta) units, MAX(MAX(e.note='pelo menos'),0) is_minimum
  FROM events e JOIN products p ON p.id=e.product_id WHERE e.type IN ('stock_down','out_of_stock') AND e.delta<0
  GROUP BY e.product_id ORDER BY units DESC LIMIT ?`).all(limit);

export const runSeries = (db) => db.prepare(`SELECT * FROM runs WHERE status IN ('success','partial') AND snap_products IS NOT NULL ORDER BY started_at DESC LIMIT 720`).all().reverse();
export const listRuns = (db, limit = 100) => db.prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT ?`).all(limit);
export const lastRun = (db) => db.prepare(`SELECT * FROM runs WHERE status<>'running' ORDER BY id DESC LIMIT 1`).get();
