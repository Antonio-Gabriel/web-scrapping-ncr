import { config } from '../config.js';
import { SOURCE_LIST } from '../sources.js';

const LOW = config.lowStockAt;
const LOW_SQL = `s.is_available=1 AND s.stock_known=1 AND s.available_qty<=${LOW}`;
const like = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;
const medianOf = (values) => {
  const a = values.filter((v) => v > 0).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export const EVENT_GROUPS = {
  all: { label: 'Tudo', types: null },
  reductions: { label: 'Reduções de stock', types: ['stock_down', 'out_of_stock', 'removed', 'to_backorder'] },
  increases: { label: 'Reposições', types: ['stock_up', 'back_in_stock', 'reappeared', 'from_backorder'] },
  new: { label: 'Produtos novos', types: ['new_product'] },
  price: { label: 'Preços', types: ['price_up', 'price_down'] },
  promo: { label: 'Promoções', types: ['promo_start', 'promo_end'] },
};

const PRICE_BANDS = [
  ['< 5 mil', 0, 5e3], ['5–25 mil', 5e3, 25e3], ['25–100 mil', 25e3, 1e5],
  ['100–500 mil', 1e5, 5e5], ['500 mil–1 M', 5e5, 1e6], ['> 1 M', 1e6, Infinity],
];
const DISCOUNT_BANDS = [['Até 5%', 0, 5], ['5–10%', 5, 10], ['10–20%', 10, 20], ['20–30%', 20, 30], ['Mais de 30%', 30, Infinity]];
const bandCounts = (values, bands) => bands.map(([label, lo, hi]) => ({ label, value: values.filter((v) => v >= lo && v < hi).length }));

/** Consultas de uma fonte. As tabelas têm as mesmas colunas em todas as fontes; só muda o prefixo. */
export function queriesFor(src) {
  const T = src.T;
  const FROM = `FROM ${T.products} p JOIN ${T.skus} s ON s.product_id=p.id
    LEFT JOIN ${T.brands} b ON b.id=p.brand_id LEFT JOIN ${T.categories} c ON c.id=p.category_id`;
  const SELECT = `SELECT p.id, p.name, p.slug, p.url, p.image_url, p.active, p.first_seen, p.reference, p.removed_at,
    b.name brand, c.name category, c.path category_path, s.id sku_id, s.price, s.list_price, s.discount_pct, s.on_promo,
    s.available_qty, s.stock_known, s.is_available, s.availability, '${src.key}' source ${FROM}`;

  // Sem quantidade publicada (Que Rápido), os filtros de stock usam o estado do produto.
  const STATUS_FILTERS = src.hasQuantity ? {
    all: { label: 'Todos', sql: 'p.active=1' },
    available: { label: 'Disponíveis', sql: 'p.active=1 AND s.is_available=1' },
    promo: { label: 'Em promoção', sql: 'p.active=1 AND s.on_promo=1' },
    low: { label: `Stock baixo (até ${LOW})`, sql: `p.active=1 AND ${LOW_SQL}` },
    out: { label: 'Esgotados', sql: 'p.active=1 AND s.is_available=0' },
    removed: { label: 'Fora do catálogo', sql: 'p.active=0' },
  } : {
    all: { label: 'Todos', sql: 'p.active=1' },
    available: { label: 'Em stock', sql: "p.active=1 AND s.availability='in_stock'" },
    backorder: { label: 'Por encomenda', sql: "p.active=1 AND s.availability='backorder'" },
    promo: { label: 'Em promoção', sql: 'p.active=1 AND s.on_promo=1' },
    out: { label: 'Fora de stock', sql: 'p.active=1 AND s.is_available=0' },
    removed: { label: 'Fora do catálogo', sql: 'p.active=0' },
  };
  const SORTS = {
    name: 'p.name COLLATE NOCASE', price: 's.price', discount: 's.discount_pct',
    stock: src.hasQuantity ? 's.available_qty' : "CASE s.availability WHEN 'in_stock' THEN 2 WHEN 'backorder' THEN 1 ELSE 0 END",
    brand: 'b.name COLLATE NOCASE', recent: 'p.first_seen',
  };

  function filterSql(f) {
    const where = []; const params = {};
    if (f.q) {
      where.push(`(p.name LIKE @q ESCAPE '\\' OR p.reference LIKE @q ESCAPE '\\' OR b.name LIKE @q ESCAPE '\\' OR s.ean = @exact)`);
      params.q = like(f.q); params.exact = f.q;
    }
    if (f.category) { where.push(`p.id IN (SELECT product_id FROM ${T.product_categories} WHERE category_id=@category)`); params.category = f.category; }
    if (f.brand) { where.push('p.brand_id=@brand'); params.brand = f.brand; }
    return { where, params };
  }

  const one = (db, sql, ...args) => db.prepare(sql).get(...args);

  const q = {
    STATUS_FILTERS,

    listProducts(db, f) {
      const { where, params } = filterSql(f);
      const status = STATUS_FILTERS[f.status] ? f.status : 'all';
      const sql = [...where, STATUS_FILTERS[status].sql].join(' AND ');
      const total = one(db, `SELECT COUNT(*) c ${FROM} WHERE ${sql}`, params).c;
      const sort = SORTS[f.sort] || SORTS.name;
      const dir = f.dir === 'desc' ? 'DESC' : 'ASC';
      const limit = f.limit ?? 25;
      const pages = Math.max(1, Math.ceil(total / limit));
      const page = Math.min(Math.max(1, f.page || 1), pages);
      const rows = db.prepare(`${SELECT} WHERE ${sql} ORDER BY ${sort} ${dir}, p.id LIMIT @limit OFFSET @offset`)
        .all({ ...params, limit, offset: (page - 1) * limit });
      const base = where.length ? `${where.join(' AND ')} AND ` : '';
      const counts = Object.entries(STATUS_FILTERS).map(([key, s]) => ({
        key, label: s.label, active: key === status, count: one(db, `SELECT COUNT(*) c ${FROM} WHERE ${base}${s.sql}`, params).c,
      }));
      return { rows, total, page, pages, limit, status, counts, from: total ? (page - 1) * limit + 1 : 0, to: Math.min(page * limit, total) };
    },

    filterOptions: (db) => ({
      departments: db.prepare(`SELECT c.id, c.path name FROM ${T.categories} c
        WHERE EXISTS (SELECT 1 FROM ${T.product_categories} pc JOIN ${T.products} p ON p.id=pc.product_id WHERE pc.category_id=c.id AND p.active=1) ORDER BY c.path`).all(),
      brands: db.prepare(`SELECT b.id, b.name FROM ${T.brands} b WHERE EXISTS (SELECT 1 FROM ${T.products} p WHERE p.brand_id=b.id AND p.active=1) ORDER BY b.name COLLATE NOCASE`).all(),
    }),

    productDetail(db, id) {
      const product = one(db, `${SELECT} WHERE p.id=? LIMIT 1`, id);
      if (!product) return null;
      const extra = one(db, `SELECT description, specs, release_date FROM ${T.products} WHERE id=?`, id);
      const hist = (table) => db.prepare(`SELECT * FROM ${table} WHERE sku_id=? ORDER BY at`).all(product.sku_id);
      return {
        product: { ...product, ...extra },
        specs: extra.specs ? Object.entries(JSON.parse(extra.specs)).map(([k, v]) => ({ k, v })) : [],
        prices: hist(T.price_history), stock: hist(T.stock_history),
        events: db.prepare(`SELECT * FROM ${T.events} WHERE product_id=? ORDER BY at DESC, id DESC LIMIT 50`).all(id),
        clusters: db.prepare(`SELECT c.name FROM ${T.product_clusters} pc JOIN ${T.clusters} c ON c.id=pc.cluster_id WHERE pc.product_id=? AND c.name<>'egoi' ORDER BY c.name`).all(id).map((c) => c.name),
      };
    },

    categoryTree(db) {
      const rows = db.prepare(`SELECT c.id, c.parent_id, c.name, c.url, c.level,
          COUNT(s.id) products, AVG(NULLIF(s.price,0)) avg_price, SUM(s.on_promo) promos,
          SUM(CASE WHEN ${src.hasQuantity ? LOW_SQL : 's.is_available=0'} THEN 1 ELSE 0 END) low
        FROM ${T.categories} c
        LEFT JOIN ${T.product_categories} pc ON pc.category_id=c.id
        LEFT JOIN ${T.products} p ON p.id=pc.product_id AND p.active=1
        LEFT JOIN ${T.skus} s ON s.product_id=p.id AND s.active=1
        WHERE c.active=1 GROUP BY c.id ORDER BY products DESC, c.name`).all();
      const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
      const roots = [];
      for (const n of byId.values()) (n.parent_id && byId.get(n.parent_id)?.children || roots).push(n);
      const prune = (list) => list.filter((n) => n.products > 0).map((n) => ({ ...n, children: prune(n.children) }));
      return { roots: prune(roots), total: rows.length, withProducts: rows.filter((r) => r.products > 0).length };
    },

    departments(db) {
      const map = new Map();
      for (const r of db.prepare(`SELECT c.id, c.name, s.price, s.on_promo, s.discount_pct, s.available_qty
        FROM ${T.categories} c JOIN ${T.product_categories} pc ON pc.category_id=c.id JOIN ${T.products} p ON p.id=pc.product_id AND p.active=1
        JOIN ${T.skus} s ON s.product_id=p.id AND s.active=1 WHERE c.level=0`).all()) {
        const d = map.get(r.id) || { id: r.id, name: r.name, products: 0, promos: 0, prices: [], stockValue: 0 };
        d.products++; d.promos += r.on_promo; d.prices.push(r.price);
        d.stockValue += (r.price || 0) * (r.available_qty || 0);
        map.set(r.id, d);
      }
      return [...map.values()].map((d) => ({ ...d, median: medianOf(d.prices), promoRate: d.products ? d.promos / d.products * 100 : 0, prices: undefined }));
    },

    summary(db) {
      const row = one(db, `SELECT COUNT(DISTINCT p.id) products, COUNT(*) skus, SUM(s.on_promo) promos,
          AVG(CASE WHEN s.on_promo=1 THEN s.discount_pct END) avg_discount, MAX(s.discount_pct) max_discount,
          SUM(CASE WHEN s.on_promo=1 THEN s.list_price-s.price ELSE 0 END) total_saving,
          SUM(CASE WHEN s.is_available=0 THEN 1 ELSE 0 END) out_of_stock,
          SUM(CASE WHEN ${LOW_SQL} THEN 1 ELSE 0 END) low_stock,
          SUM(CASE WHEN s.is_available=1 AND s.stock_known=0 THEN 1 ELSE 0 END) capped,
          SUM(CASE WHEN s.is_available=1 AND s.stock_known=1 AND s.available_qty>${LOW} THEN 1 ELSE 0 END) mid_stock,
          SUM(CASE WHEN s.availability='in_stock' THEN 1 ELSE 0 END) in_stock,
          SUM(CASE WHEN s.availability='backorder' THEN 1 ELSE 0 END) backorder,
          AVG(NULLIF(s.price,0)) avg_price, SUM(s.price*COALESCE(s.available_qty,0)) stock_value,
          SUM(COALESCE(s.available_qty,0)) units
        FROM ${T.products} p JOIN ${T.skus} s ON s.product_id=p.id WHERE p.active=1`);
      return {
        ...row,
        median_price: medianOf(db.prepare(`SELECT s.price FROM ${T.skus} s WHERE s.active=1`).all().map((s) => s.price)),
        categories: one(db, `SELECT COUNT(DISTINCT pc.category_id) c FROM ${T.product_categories} pc JOIN ${T.products} p ON p.id=pc.product_id AND p.active=1`).c,
        brands: one(db, `SELECT COUNT(DISTINCT brand_id) c FROM ${T.products} WHERE active=1`).c,
        stores: one(db, `SELECT COUNT(*) c FROM ${T.stores} WHERE active=1 AND source='nossas-lojas'`).c,
        pickup: one(db, `SELECT COUNT(*) c FROM ${T.stores} WHERE active=1 AND source<>'nossas-lojas'`).c,
      };
    },

    listEvents(db, { group = 'all', page = 1, limit = 30 } = {}) {
      const g = EVENT_GROUPS[group] ? group : 'all';
      const types = EVENT_GROUPS[g].types;
      const where = types ? `WHERE e.type IN (${types.map(() => '?').join(',')})` : '';
      const args = types || [];
      const total = one(db, `SELECT COUNT(*) c FROM ${T.events} e ${where}`, ...args).c;
      const pages = Math.max(1, Math.ceil(total / limit));
      const p = Math.min(Math.max(1, page), pages);
      const rows = db.prepare(`SELECT e.*, pr.name product_name, pr.image_url FROM ${T.events} e JOIN ${T.products} pr ON pr.id=e.product_id ${where}
        ORDER BY e.at DESC, e.id DESC LIMIT ? OFFSET ?`).all(...args, limit, (p - 1) * limit).map((r) => ({ ...r, source: src.key }));
      const counts = Object.entries(EVENT_GROUPS).map(([key, v]) => ({
        key, label: v.label, active: key === g,
        count: v.types
          ? one(db, `SELECT COUNT(*) c FROM ${T.events} WHERE type IN (${v.types.map(() => '?').join(',')})`, ...v.types).c
          : one(db, `SELECT COUNT(*) c FROM ${T.events}`).c,
      }));
      return { rows, total, page: p, pages, group: g, counts, from: total ? (p - 1) * limit + 1 : 0, to: Math.min(p * limit, total) };
    },

    eventsSince: (db, hours) => one(db, `SELECT
        COALESCE(SUM(type IN ('stock_down','out_of_stock','removed','to_backorder')),0) reductions, COALESCE(SUM(type='new_product'),0) new_products,
        COALESCE(SUM(type IN ('price_up','price_down')),0) price_changes, COALESCE(SUM(type IN ('promo_start','promo_end')),0) promo_changes
      FROM ${T.events} WHERE at >= ?`, new Date(Date.now() - hours * 3600_000).toISOString()),

    lowStock: (db, limit = 10) => (src.hasQuantity
      ? db.prepare(`${SELECT} WHERE p.active=1 AND ${LOW_SQL} ORDER BY s.available_qty, s.price DESC LIMIT ?`).all(limit)
      : db.prepare(`${SELECT} WHERE p.active=1 AND s.is_available=0 ORDER BY s.price DESC LIMIT ?`).all(limit)),

    topPromos: (db, limit = 6) => db.prepare(`${SELECT} WHERE p.active=1 AND s.on_promo=1 ORDER BY s.discount_pct DESC LIMIT ?`).all(limit)
      .map((r) => ({ ...r, source: src.key })),

    campaigns(db) {
      const active = one(db, `SELECT COUNT(*) c FROM ${T.products} WHERE active=1`).c;
      // Coleções que cobrem quase todo o catálogo são técnicas (ex.: marketing), não campanhas.
      return db.prepare(`SELECT c.id, c.name, COUNT(*) products, SUM(s.on_promo) promos, AVG(CASE WHEN s.on_promo=1 THEN s.discount_pct END) avg_discount
        FROM ${T.clusters} c JOIN ${T.product_clusters} pc ON pc.cluster_id=c.id JOIN ${T.products} p ON p.id=pc.product_id AND p.active=1
        JOIN ${T.skus} s ON s.product_id=p.id GROUP BY c.id HAVING products < ? ORDER BY promos DESC, products DESC`).all(active * 0.5);
    },

    stores: (db) => db.prepare(`SELECT * FROM ${T.stores} WHERE active=1 ORDER BY source='pickup-points', city, name`).all(),

    brandRanking: (db, limit = 10) => db.prepare(`SELECT b.id, b.name, COUNT(*) products, SUM(s.price*COALESCE(s.available_qty,0)) stock_value
      FROM ${T.products} p JOIN ${T.skus} s ON s.product_id=p.id JOIN ${T.brands} b ON b.id=p.brand_id WHERE p.active=1
      GROUP BY b.id ORDER BY products DESC LIMIT ?`).all(limit),

    priceBands: (db) => bandCounts(db.prepare(`SELECT price v FROM ${T.skus} WHERE active=1 AND price>0`).all().map((r) => r.v), PRICE_BANDS),
    discountBands: (db) => bandCounts(db.prepare(`SELECT discount_pct v FROM ${T.skus} WHERE active=1 AND on_promo=1`).all().map((r) => r.v), DISCOUNT_BANDS),

    priceExtremes: (db, limit = 6) => ({
      highest: db.prepare(`${SELECT} WHERE p.active=1 ORDER BY s.price DESC LIMIT ?`).all(limit),
      lowest: db.prepare(`${SELECT} WHERE p.active=1 AND s.price>0 ORDER BY s.price ASC LIMIT ?`).all(limit),
    }),

    topMovers: (db, limit = 10) => db.prepare(`SELECT e.product_id id, p.name, p.image_url, '${src.key}' source, COUNT(*) reductions,
        SUM(-e.delta) units, MAX(MAX(e.note='pelo menos'),0) is_minimum
      FROM ${T.events} e JOIN ${T.products} p ON p.id=e.product_id WHERE e.type IN ('stock_down','out_of_stock') AND e.delta<0
      GROUP BY e.product_id ORDER BY units DESC LIMIT ?`).all(limit),

    runSeries: (db) => db.prepare(`SELECT * FROM ${T.runs} WHERE status IN ('success','partial') AND snap_products IS NOT NULL ORDER BY started_at DESC LIMIT 720`).all().reverse(),
    listRuns: (db, limit = 100) => db.prepare(`SELECT * FROM ${T.runs} ORDER BY id DESC LIMIT ?`).all(limit),
    lastRun: (db) => one(db, `SELECT * FROM ${T.runs} WHERE status<>'running' ORDER BY id DESC LIMIT 1`),
    hasData: (db) => !!one(db, `SELECT 1 FROM ${T.products} LIMIT 1`),
  };
  return q;
}

export const Q = Object.fromEntries(SOURCE_LIST.map((s) => [s.key, queriesFor(s)]));
