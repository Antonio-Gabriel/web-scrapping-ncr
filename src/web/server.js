import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { engine } from 'express-handlebars';
import { ROOT, config } from '../config.js';
import { openDb } from '../db.js';
import { isRunning, registerLive } from './live.js';
import * as q from './queries.js';
import {
  helpers, kzShort, num, pct, stockLabel, toBars,
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
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https://*.vteximg.com.br https://*.vtexassets.com; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'",
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

const str = (v) => (typeof v === 'string' ? v.trim().slice(0, 120) : '');
const int = (v) => { const n = Number.parseInt(str(v), 10); return Number.isSafeInteger(n) && n > 0 ? n : undefined; };

app.use((req, res, next) => {
  if (!fs.existsSync(config.dbPath)) {
    return res.status(503).type('text/plain').send('Base de dados vazia. Corre primeiro: npm run sync');
  }
  const run = q.lastRun(getDb());
  const minutes = run?.finished_at ? (Date.now() - new Date(run.finished_at)) / 60000 : Infinity;
  const nextHour = new Date(); nextHour.setMinutes(60, 0, 0);
  res.locals.nav = NAV.map((g) => ({
    ...g,
    items: g.items.map((i) => ({ ...i, active: i.href === '/' ? req.path === '/' : req.path.startsWith(i.href) })),
  }));
  res.locals.sync = {
    run, stale: minutes > 130, failed: run?.status === 'failed',
    next: new Intl.DateTimeFormat('pt-PT', { timeZone: 'Africa/Luanda', timeStyle: 'short' }).format(nextHour),
  };
  res.locals.searchValue = req.path.startsWith('/produtos') ? str(req.query.q) : '';
  next();
});

const asSeries = (rows, field) => rows.filter((r) => r[field] != null).map((r) => ({ t: r.started_at, v: r[field] }));

app.get('/', (_req, res) => {
  const d = getDb();
  const s = q.summary(d);
  res.render('home', {
    title: 'Visão geral', s, day: q.eventsSince(d, 24),
    events: q.listEvents(d, { limit: 8 }).rows,
    low: q.lowStock(d, 6), promos: q.topPromos(d, 5),
    deps: toBars(q.departments(d).sort((a, b) => b.products - a.products), (r) => r.products, (r) => r.name, (r) => num(r.products), (r) => `/produtos?category=${r.id}`),
    hasEvents: d.prepare('SELECT 1 FROM events LIMIT 1').get(),
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
  const f = productFilters(req);
  const data = q.listProducts(d, f);
  const opts = q.filterOptions(d);
  const query = { q: f.q, category: f.category, brand: f.brand, status: f.status, sort: f.sort, dir: f.dir };
  res.render('produtos', {
    title: 'Produtos', ...data, f, query,
    departments: opts.departments.map((o) => ({ ...o, selected: o.id === f.category })),
    brands: opts.brands.map((o) => ({ ...o, selected: o.id === f.brand })),
    exportUrl: helpers.link('/produtos.csv', query, { hash: {} }),
  });
});

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // impede a execução de fórmulas ao abrir na folha de cálculo
  return `"${s.replace(/"/g, '""')}"`;
};

app.get('/produtos.csv', (req, res) => {
  const { rows } = q.listProducts(getDb(), { ...productFilters(req), page: 1, limit: 5000 });
  const head = ['ID', 'Produto', 'Referência', 'Marca', 'Categoria', 'Preço (Kz)', 'Preço de tabela (Kz)', 'Desconto (%)', 'Stock', 'Disponível', 'URL'];
  const body = rows.map((r) => [r.id, r.name, r.reference, r.brand, r.category_path, r.price, r.list_price, r.discount_pct, stockLabel(r.available_qty), r.is_available ? 'Sim' : 'Não', r.url].map(csvCell).join(';'));
  res.type('text/csv; charset=utf-8').attachment('andrascrapy-produtos.csv').send(`﻿${head.map(csvCell).join(';')}\n${body.join('\n')}\n`);
});

app.get('/produtos/:id', (req, res, next) => {
  const id = int(req.params.id);
  const data = id && q.productDetail(getDb(), id);
  if (!data) return next();
  res.render('produto', {
    title: data.product.name, ...data,
    priceSeries: data.prices.map((p) => ({ t: p.at, v: p.price })),
    stockSeries: data.stock.map((p) => ({ t: p.at, v: p.available_qty })),
  });
});

app.get('/categorias', (_req, res) => {
  res.render('categorias', { title: 'Categorias', ...q.categoryTree(getDb()) });
});

app.get('/precos', (_req, res) => {
  const d = getDb();
  const bands = q.priceBands(d);
  const max = Math.max(...bands.map((b) => b.value), 1);
  res.render('precos', {
    title: 'Preços', s: q.summary(d),
    bands: bands.map((b) => ({ ...b, height: Math.max(b.value ? 2 : 0, (b.value / max) * 100).toFixed(1), display: num(b.value) })),
    medians: toBars(q.departments(d).sort((a, b) => b.median - a.median), (r) => r.median, (r) => r.name, (r) => kzShort(r.median), (r) => `/produtos?category=${r.id}&sort=price`),
    ...q.priceExtremes(d),
    changes: q.listEvents(d, { group: 'price', limit: 12 }).rows,
  });
});

app.get('/promocoes', (req, res) => {
  const d = getDb();
  const page = int(req.query.page);
  const list = q.listProducts(d, { status: 'promo', sort: 'discount', dir: 'desc', page, category: int(req.query.category) });
  const bands = q.discountBands(d);
  const max = Math.max(...bands.map((b) => b.value), 1);
  const deps = q.departments(d).filter((x) => x.promos > 0).sort((a, b) => b.promos - a.promos);
  res.render('promocoes', {
    title: 'Promoções', ...list, s: q.summary(d), query: { category: req.query.category && int(req.query.category) },
    bands: bands.map((b) => ({ ...b, height: Math.max(b.value ? 2 : 0, (b.value / max) * 100).toFixed(1), display: num(b.value) })),
    deps: toBars(deps, (r) => r.promos, (r) => r.name, (r) => `${num(r.promos)} (${pct(r.promoRate)})`, (r) => `/promocoes?category=${r.id}`),
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
  const all = q.stores(getDb()).map((s) => ({
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

app.get('/stock', (req, res) => {
  const d = getDb();
  const s = q.summary(d);
  const data = q.listEvents(d, { group: str(req.query.tipo), page: int(req.query.page) || 1 });
  res.render('stock', {
    title: 'Stock e alterações', s, ...data, query: { tipo: data.group === 'all' ? '' : data.group },
    day: q.eventsSince(d, 24), week: q.eventsSince(d, 24 * 7), low: q.lowStock(d, 12), levels: stockLevels(s),
  });
});

function stockLevels(s) {
  const total = (s.low_stock + s.mid_stock + s.capped + s.out_of_stock) || 1;
  return [
    { label: 'Esgotado', value: s.out_of_stock, color: '#86b6ef', href: '/produtos?status=out' },
    { label: `1 a 5 unidades`, value: s.low_stock, color: '#5598e7', href: '/produtos?status=low' },
    { label: '6 a 49 unidades', value: s.mid_stock, color: '#256abf', href: '/produtos?status=available&sort=stock' },
    { label: '50 ou mais', value: s.capped, color: '#104281', href: '/produtos?status=available&sort=stock&dir=desc' },
  ].filter((x) => x.value > 0).map((x) => ({ ...x, share: (x.value / total * 100).toFixed(2), display: `${num(x.value)} (${pct(x.value / total * 100)})` }));
}

app.get('/bi', (_req, res) => {
  const d = getDb();
  const s = q.summary(d);
  const deps = q.departments(d);
  const runs = q.runSeries(d);
  const brands = q.brandRanking(d, 10);
  const series = [
    { title: 'Produtos no catálogo', format: 'num', points: asSeries(runs, 'snap_products') },
    { title: 'Produtos em promoção', format: 'num', points: asSeries(runs, 'snap_promos') },
    { title: 'Produtos com stock baixo', format: 'num', points: asSeries(runs, 'snap_low_stock') },
    { title: 'Preço mediano', format: 'kz', points: asSeries(runs, 'snap_median_price') },
  ];
  const bands = q.discountBands(d);
  const max = Math.max(...bands.map((b) => b.value), 1);
  res.render('bi', {
    title: 'Business Intelligence', s, levels: stockLevels(s), series, runCount: runs.length, hasSeries: runs.length >= 2,
    value: toBars([...deps].sort((a, b) => b.stockValue - a.stockValue), (r) => r.stockValue, (r) => r.name, (r) => kzShort(r.stockValue), (r) => `/produtos?category=${r.id}`),
    promoRate: toBars([...deps].sort((a, b) => b.promoRate - a.promoRate), (r) => r.promoRate, (r) => r.name, (r) => pct(r.promoRate), (r) => `/promocoes?category=${r.id}`),
    medians: toBars([...deps].sort((a, b) => b.median - a.median), (r) => r.median, (r) => r.name, (r) => kzShort(r.median), (r) => `/produtos?category=${r.id}&sort=price`),
    brands: toBars(brands, (r) => r.products, (r) => r.name, (r) => num(r.products), (r) => `/produtos?brand=${r.id}`),
    bands: bands.map((b) => ({ ...b, height: Math.max(b.value ? 2 : 0, (b.value / max) * 100).toFixed(1), display: num(b.value) })),
    movers: q.topMovers(d),
  });
});

app.get('/execucoes', (_req, res) => {
  const runs = q.listRuns(getDb()).map((r) => ({
    ...r,
    seconds: r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000) : null,
  }));
  res.render('execucoes', { title: 'Execuções', runs, running: isRunning() });
});

registerLive(app);

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
