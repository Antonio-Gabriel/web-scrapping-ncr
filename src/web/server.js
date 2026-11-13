import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { engine } from 'express-handlebars';
import { ROOT, config } from '../config.js';
import { openDb } from '../db.js';
import { SOURCE_LIST, sourceFor } from '../sources.js';
import { isRunning, registerLive } from './live.js';
import { DATASETS, FORMATS, MAX_ROWS, render } from './export.js';
import { Q } from './queries.js';
import {
  helpers, kzShort, num, pct, toBars,
} from './format.js';

const app = express();
app.disable('x-powered-by');
app.engine('hbs', engine({
  extname: '.hbs', defaultLayout: 'main', helpers,
  layoutsDir: path.join(ROOT, 'views/layouts'), partialsDir: path.join(ROOT, 'views/partials'),
}));
app.set('view engine', 'hbs');
app.set('views', path.join(ROOT, 'views'));

app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https://*.vteximg.com.br https://*.vtexassets.com https://www.querapidoangola.com; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
  });
  next();
});
app.use(express.static(path.join(ROOT, 'public')));
app.use('/fonts', express.static(path.join(ROOT, 'node_modules/@fontsource-variable/inter/files')));

let db;
function getDb() {
  if (!db) db = openDb({ readonly: true });
  return db;
}

const NAV = [
  { group: 'Catálogo', items: [
    { href: '/', label: 'Visão geral', icon: 'home' }, { href: '/produtos', label: 'Produtos', icon: 'box' },
    { href: '/categorias', label: 'Categorias', icon: 'tree' }, { href: '/precos', label: 'Preços', icon: 'tag' },
    { href: '/promocoes', label: 'Promoções', icon: 'percent' }, { href: '/lojas', label: 'Lojas', icon: 'store' },
  ] },
  { group: 'Análise', items: [
    { href: '/stock', label: 'Stock e alterações', icon: 'activity' }, { href: '/bi', label: 'BI', icon: 'chart' },
    { href: '/execucoes', label: 'Execuções', icon: 'clock' },
  ] },
];
// Páginas com separadores por fonte (NCR Angola / Que Rápido).
const TABBED = new Set(['/produtos', '/categorias', '/precos', '/promocoes', '/lojas', '/stock', '/bi', '/execucoes', '/execucoes/ao-vivo']);

const str = (v) => (typeof v === 'string' ? v.trim().slice(0, 120) : '');
const int = (v) => { const n = Number.parseInt(str(v), 10); return Number.isSafeInteger(n) && n > 0 ? n : undefined; };
const fonteKey = (src) => (src.key === 'ncr' ? '' : src.key);
/** Acrescenta a fonte a um endereço interno (a NCR é a fonte por omissão e não precisa do parâmetro). */
const withF = (src, url) => (src.key === 'ncr' ? url : `${url}${url.includes('?') ? '&' : '?'}fonte=${src.key}`);
const LUANDA_TIME = new Intl.DateTimeFormat('pt-PT', { timeZone: 'Africa/Luanda', timeStyle: 'short' });
function nextAt(minute) {
  const d = new Date();
  d.setSeconds(0, 0);
  if (d.getMinutes() >= minute) d.setHours(d.getHours() + 1);
  d.setMinutes(minute);
  return LUANDA_TIME.format(d);
}

app.use((req, res, next) => {
  if (!fs.existsSync(config.dbPath)) {
    return res.status(503).type('text/plain').send('Base de dados vazia. Corre primeiro: npm run sync');
  }
  const d = getDb();
  const src = sourceFor(str(req.query.fonte));
  res.locals.src = src;
  res.locals.fonteKey = fonteKey(src);
  res.locals.fq = src.key === 'ncr' ? '' : `?fonte=${src.key}`;
  res.locals.fa = src.key === 'ncr' ? '' : `&fonte=${src.key}`;
  res.locals.nav = NAV.map((g) => ({
    ...g,
    items: g.items.map((i) => ({ ...i, active: i.href === '/' ? req.path === '/' : req.path.startsWith(i.href) })),
  }));
  res.locals.syncs = SOURCE_LIST.map((s) => {
    const run = Q[s.key].lastRun(d);
    const minutes = run?.finished_at ? (Date.now() - new Date(run.finished_at)) / 60000 : Infinity;
    return { name: s.short, run, never: !run, stale: minutes > 130, failed: run?.status === 'failed', next: nextAt(s.cronMinute) };
  });
  if (TABBED.has(req.path)) {
    res.locals.sourceTabs = SOURCE_LIST.map((s) => ({
      name: s.name, active: s.key === src.key, href: s.key === 'ncr' ? req.path : `${req.path}?fonte=${s.key}`,
      count: Q[s.key].summary(d).products,
    }));
  }
  res.locals.headerSite = { url: src.baseUrl, label: new URL(src.baseUrl).hostname.replace(/^www\./, '') };
  res.locals.searchValue = req.path.startsWith('/produtos') ? str(req.query.q) : '';
  next();
});

const asSeries = (rows, field) => rows.filter((r) => r[field] != null).map((r) => ({ t: r.started_at, v: r[field] }));
const medianOf = (values) => {
  const a = values.filter((v) => v > 0).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// Visão geral: as duas fontes juntas.
app.get('/', (_req, res) => {
  const d = getDb();
  const per = SOURCE_LIST.map((s) => ({ s, sum: Q[s.key].summary(d) }));
  const sum = (k) => per.reduce((a, x) => a + (x.sum[k] || 0), 0);
  const note = (k, fmt = num) => per.map((x) => `${x.s.short} ${fmt(x.sum[k] || 0)}`).join(' · ');
  const prices = SOURCE_LIST.flatMap((s) => d.prepare(`SELECT price FROM ${s.T.skus} WHERE active=1`).all().map((r) => r.price));
  const days = SOURCE_LIST.map((s) => Q[s.key].eventsSince(d, 24));
  const deps = SOURCE_LIST.flatMap((s) => Q[s.key].departments(d).map((x) => ({ ...x, src: s })))
    .sort((a, b) => b.products - a.products).slice(0, 8);
  res.render('home', {
    title: 'Visão geral', combined: true,
    total: {
      products: sum('products'), categories: sum('categories'), brands: sum('brands'), promos: sum('promos'),
      out_of_stock: sum('out_of_stock'), median_price: medianOf(prices),
    },
    notes: {
      products: note('products'), categories: note('categories'), brands: note('brands'), promos: note('promos'),
      out_of_stock: note('out_of_stock'), median_price: note('median_price', kzShort),
    },
    ncr: per[0].sum,
    day: Object.fromEntries(['reductions', 'new_products', 'price_changes'].map((k) => [k, days.reduce((a, x) => a + (x[k] || 0), 0)])),
    bySource: toBars(per, (x) => x.sum.products, (x) => x.s.name, (x) => num(x.sum.products), (x) => withF(x.s, '/produtos')),
    deps: toBars(deps, (r) => r.products, (r) => `${r.name} · ${r.src.short}`, (r) => num(r.products), (r) => withF(r.src, `/produtos?category=${r.id}`)),
    events: SOURCE_LIST.flatMap((s) => Q[s.key].listEvents(d, { limit: 8 }).rows).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8),
    promos: SOURCE_LIST.flatMap((s) => Q[s.key].topPromos(d, 6)).sort((a, b) => b.discount_pct - a.discount_pct).slice(0, 6),
    low: Q.ncr.lowStock(d, 6),
  });
});

function productFilters(req) {
  return {
    q: str(req.query.q), category: int(req.query.category), brand: int(req.query.brand), status: str(req.query.status),
    sort: str(req.query.sort), dir: str(req.query.dir), page: int(req.query.page),
  };
}

app.get('/produtos', (req, res) => {
  const d = getDb();
  const src = res.locals.src;
  const q = Q[src.key];
  const f = productFilters(req);
  const data = q.listProducts(d, f);
  const opts = q.filterOptions(d);
  const query = { q: f.q, category: f.category, brand: f.brand, status: f.status, sort: f.sort, dir: f.dir, fonte: fonteKey(src) };
  res.render('produtos', {
    title: 'Produtos', ...data, f, query,
    departments: opts.departments.map((o) => ({ ...o, selected: o.id === f.category })),
    brands: opts.brands.map((o) => ({ ...o, selected: o.id === f.brand })),
    exportQs: exportQs(query),
  });
});

/** Parâmetros da exportação: os mesmos filtros da página, sem a paginação. */
function exportQs(query) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

// Endereço antigo: continua a funcionar, agora pela exportação genérica.
app.get('/produtos.csv', (req, res) => {
  const qs = new URLSearchParams(Object.entries(req.query).filter(([, v]) => typeof v === 'string')).toString();
  res.redirect(301, `/exportar/produtos/csv${qs ? `?${qs}` : ''}`);
});

app.get('/exportar/:dataset/:fmt', async (req, res, next) => {
  const ds = DATASETS[req.params.dataset];
  const fmt = FORMATS[req.params.fmt];
  if (!ds || !fmt) return next();
  const src = res.locals.src;
  const q = Q[src.key];
  const d = getDb();
  let raw; const described = [];
  if (req.params.dataset === 'produtos') {
    const f = productFilters(req);
    raw = q.listProducts(d, { ...f, page: 1, limit: MAX_ROWS }).rows;
    if (f.q) described.push(`pesquisa "${f.q}"`);
    if (f.status && q.STATUS_FILTERS[f.status]) described.push(q.STATUS_FILTERS[f.status].label);
    if (f.category) described.push(`categoria ${d.prepare(`SELECT path FROM ${src.T.categories} WHERE id=?`).get(f.category)?.path ?? f.category}`);
    if (f.brand) described.push(`marca ${d.prepare(`SELECT name FROM ${src.T.brands} WHERE id=?`).get(f.brand)?.name ?? f.brand}`);
  } else {
    const data = q.listEvents(d, { group: str(req.query.tipo), page: 1, limit: MAX_ROWS });
    raw = data.rows;
    if (data.group !== 'all') described.push(data.counts.find((c) => c.active)?.label);
  }
  const rows = raw.map((r) => ds.map(r, src));
  const meta = { loja: src.name, filtros: described.filter(Boolean).join(', '), gerado_em: new Date().toISOString() };
  try {
    const body = await render(req.params.fmt, ds, rows, meta);
    const stamp = new Date().toISOString().slice(0, 10);
    res.type(fmt.type).attachment(`andrascrapy-${src.key}-${req.params.dataset}-${stamp}.${fmt.ext}`).send(body);
  } catch (e) {
    next(e);
  }
});

app.get('/produtos/:id', (req, res, next) => {
  const id = int(req.params.id);
  const data = id && Q[res.locals.src.key].productDetail(getDb(), id);
  if (!data) return next();
  res.render('produto', {
    title: data.product.name, ...data,
    priceSeries: data.prices.map((p) => ({ t: p.at, v: p.price })),
    stockSeries: data.stock.filter((p) => p.available_qty != null).map((p) => ({ t: p.at, v: p.available_qty })),
  });
});

app.get('/categorias', (_req, res) => {
  res.render('categorias', { title: 'Categorias', ...Q[res.locals.src.key].categoryTree(getDb()) });
});

const columns = (bands) => {
  const max = Math.max(...bands.map((b) => b.value), 1);
  return bands.map((b) => ({ ...b, height: Math.max(b.value ? 2 : 0, (b.value / max) * 100).toFixed(1), display: num(b.value) }));
};

app.get('/precos', (_req, res) => {
  const d = getDb();
  const src = res.locals.src;
  const q = Q[src.key];
  res.render('precos', {
    title: 'Preços', s: q.summary(d), bands: columns(q.priceBands(d)),
    medians: toBars(q.departments(d).sort((a, b) => b.median - a.median), (r) => r.median, (r) => r.name, (r) => kzShort(r.median), (r) => withF(src, `/produtos?category=${r.id}&sort=price`)),
    ...q.priceExtremes(d),
    changes: q.listEvents(d, { group: 'price', limit: 12 }).rows,
  });
});

app.get('/promocoes', (req, res) => {
  const d = getDb();
  const src = res.locals.src;
  const q = Q[src.key];
  const list = q.listProducts(d, { status: 'promo', sort: 'discount', dir: 'desc', page: int(req.query.page), category: int(req.query.category) });
  const deps = q.departments(d).filter((x) => x.promos > 0).sort((a, b) => b.promos - a.promos);
  res.render('promocoes', {
    title: 'Promoções', ...list, s: q.summary(d), query: { category: req.query.category && int(req.query.category), fonte: fonteKey(src) },
    exportQs: exportQs({ status: 'promo', sort: 'discount', dir: 'desc', category: int(req.query.category), fonte: fonteKey(src) }),
    bands: columns(q.discountBands(d)),
    deps: toBars(deps, (r) => r.promos, (r) => r.name, (r) => `${num(r.promos)} (${pct(r.promoRate)})`, (r) => withF(src, `/promocoes?category=${r.id}`)),
    campaigns: q.campaigns(d).filter((c) => c.promos > 0).slice(0, 8),
  });
});

const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
function storeHours(h) {
  if (!h) return null;
  const parsed = JSON.parse(h);
  if (typeof parsed === 'string') return parsed;
  return parsed.map((x) => `${DAY_NAMES[x.DayOfWeek]} ${x.OpeningTime.slice(0, 5)}–${x.ClosingTime.slice(0, 5)}`).join(' · ');
}

app.get('/lojas', (_req, res) => {
  const all = Q[res.locals.src.key].stores(getDb()).map((s) => ({
    ...s, hoursText: storeHours(s.hours),
    mapUrl: s.lat != null ? `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}` : null,
  }));
  res.render('lojas', {
    title: 'Lojas',
    physical: all.filter((s) => s.source === 'nossas-lojas'),
    pickup: all.filter((s) => s.source !== 'nossas-lojas'),
    cities: new Set(all.filter((s) => s.city).map((s) => s.city)).size,
  });
});

/** Distribuição do stock: por quantidade na NCR; por estado na Que Rápido (que não publica quantidades). */
function stockLevels(s, src) {
  const levels = src.hasQuantity ? [
    { label: 'Esgotado', value: s.out_of_stock, color: '#86b6ef', href: '/produtos?status=out' },
    { label: '1 a 5 unidades', value: s.low_stock, color: '#5598e7', href: '/produtos?status=low' },
    { label: '6 a 49 unidades', value: s.mid_stock, color: '#256abf', href: '/produtos?status=available&sort=stock' },
    { label: '50 ou mais', value: s.capped, color: '#104281', href: '/produtos?status=available&sort=stock&dir=desc' },
  ] : [
    { label: 'Fora de stock', value: s.out_of_stock, color: '#86b6ef', href: '/produtos?status=out' },
    { label: 'Por encomenda', value: s.backorder, color: '#5598e7', href: '/produtos?status=backorder' },
    { label: 'Em stock', value: s.in_stock, color: '#104281', href: '/produtos?status=available' },
  ];
  const total = levels.reduce((a, x) => a + (x.value || 0), 0) || 1;
  return levels.filter((x) => x.value > 0).map((x) => ({
    ...x, href: withF(src, x.href), share: (x.value / total * 100).toFixed(2), display: `${num(x.value)} (${pct(x.value / total * 100)})`,
  }));
}

app.get('/stock', (req, res) => {
  const d = getDb();
  const src = res.locals.src;
  const q = Q[src.key];
  const s = q.summary(d);
  const data = q.listEvents(d, { group: str(req.query.tipo), page: int(req.query.page) || 1 });
  res.render('stock', {
    title: 'Stock e alterações', s, ...data, query: { tipo: data.group === 'all' ? '' : data.group, fonte: fonteKey(src) },
    exportQs: exportQs({ tipo: data.group === 'all' ? '' : data.group, fonte: fonteKey(src) }),
    day: q.eventsSince(d, 24), week: q.eventsSince(d, 24 * 7), low: q.lowStock(d, 12), levels: stockLevels(s, src),
  });
});

app.get('/bi', (_req, res) => {
  const d = getDb();
  const src = res.locals.src;
  const q = Q[src.key];
  const s = q.summary(d);
  const deps = q.departments(d);
  const runs = q.runSeries(d);
  const series = [
    { title: 'Produtos no catálogo', format: 'num', points: asSeries(runs, 'snap_products') },
    { title: 'Produtos em promoção', format: 'num', points: asSeries(runs, 'snap_promos') },
    src.hasQuantity
      ? { title: 'Produtos com stock baixo', format: 'num', points: asSeries(runs, 'snap_low_stock') }
      : { title: 'Produtos fora de stock', format: 'num', points: asSeries(runs, 'snap_out_of_stock') },
    { title: 'Preço mediano', format: 'kz', points: asSeries(runs, 'snap_median_price') },
  ];
  res.render('bi', {
    title: 'Business Intelligence', s, levels: stockLevels(s, src), series, runCount: runs.length, hasSeries: runs.length >= 2,
    value: toBars([...deps].sort((a, b) => b.stockValue - a.stockValue), (r) => r.stockValue, (r) => r.name, (r) => kzShort(r.stockValue), (r) => withF(src, `/produtos?category=${r.id}`)),
    promoRate: toBars([...deps].sort((a, b) => b.promoRate - a.promoRate), (r) => r.promoRate, (r) => r.name, (r) => pct(r.promoRate), (r) => withF(src, `/promocoes?category=${r.id}`)),
    medians: toBars([...deps].sort((a, b) => b.median - a.median), (r) => r.median, (r) => r.name, (r) => kzShort(r.median), (r) => withF(src, `/produtos?category=${r.id}&sort=price`)),
    brands: toBars(q.brandRanking(d, 10), (r) => r.products, (r) => r.name, (r) => num(r.products), (r) => withF(src, `/produtos?brand=${r.id}`)),
    bands: columns(q.discountBands(d)),
    movers: q.topMovers(d),
  });
});

app.get('/execucoes', (_req, res) => {
  const src = res.locals.src;
  const runs = Q[src.key].listRuns(getDb()).map((r) => ({
    ...r,
    seconds: r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000) : null,
  }));
  res.render('execucoes', { title: 'Execuções', runs, running: isRunning(src) });
});

registerLive(app, express);

app.use((_req, res) => res.status(404).render('erro', { title: 'Página não encontrada', message: 'Esta página não existe.' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).render('erro', { title: 'Erro', message: 'Não foi possível carregar esta página. Consulta os registos do servidor.' });
});

app.listen(config.port, config.host, (err) => {
  if (err) {
    console.error(err.code === 'EADDRINUSE'
      ? `A porta ${config.port} já está ocupada. Fecha o outro dashboard ou usa PORT=<outra porta>.`
      : err);
    process.exit(1);
  }
  console.log(`${config.name}: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
});

