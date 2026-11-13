import Handlebars from 'handlebars';
import { config } from '../config.js';

const TZ = 'Africa/Luanda';
const NUM = new Intl.NumberFormat('pt-PT', { useGrouping: 'always' });
const MONEY = new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' });
const DATE = new Intl.DateTimeFormat('pt-PT', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });

export const kz = (v) => (v == null ? '—' : `${MONEY.format(v)} Kz`);
export const kzShort = (v) => {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toLocaleString('pt-PT', { maximumFractionDigits: 2 })} mil M Kz`;
  if (abs >= 1e6) return `${(v / 1e6).toLocaleString('pt-PT', { maximumFractionDigits: 1 })} M Kz`;
  if (abs >= 1e3) return `${NUM.format(Math.round(v / 1e3))} mil Kz`;
  return `${NUM.format(Math.round(v))} Kz`;
};
export const num = (v) => (v == null ? '—' : NUM.format(v));
export const pct = (v) => (v == null ? '—' : `${Number(v).toLocaleString('pt-PT', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);
export const date = (v) => (v ? DATE.format(new Date(v)) : '—');
export function ago(v) {
  if (!v) return '—';
  const min = Math.round((Date.now() - new Date(v)) / 60000);
  if (min < 1) return 'agora mesmo';
  if (min < 60) return `há ${min} min`;
  if (min < 1440) return `há ${Math.round(min / 60)} h`;
  return `há ${Math.round(min / 1440)} d`;
}
export const stockLabel = (qty) => {
  if (qty == null) return 'Sem leitura';
  if (qty >= config.stockCap) return `${config.stockCap}+`;
  return String(qty);
};

const EVENT_META = {
  new_product: ['Produto novo', 'info'], removed: ['Saiu do catálogo', 'serious'], reappeared: ['Voltou ao catálogo', 'good'],
  stock_down: ['Stock reduzido', 'warning'], stock_up: ['Stock aumentou', 'good'], out_of_stock: ['Esgotou', 'critical'],
  back_in_stock: ['Reposto', 'good'], price_up: ['Preço subiu', 'warning'], price_down: ['Preço desceu', 'good'],
  promo_start: ['Entrou em promoção', 'promo'], promo_end: ['Saiu de promoção', 'neutral'],
};
export const eventLabel = (t) => EVENT_META[t]?.[0] || t;
export const eventTone = (t) => EVENT_META[t]?.[1] || 'neutral';
export function eventDetail(e) {
  if (e.type === 'price_up' || e.type === 'price_down') return `${kz(e.old_value)} → ${kz(e.new_value)}`;
  if (e.type === 'new_product') return e.new_value != null ? kz(e.new_value) : '';
  if (e.type === 'promo_start') return e.note ? `Desconto de ${e.note.replace('.', ',')}` : '';
  if (['stock_down', 'stock_up', 'out_of_stock', 'back_in_stock'].includes(e.type)) {
    const units = e.delta != null ? ` (${e.note === 'pelo menos' ? 'pelo menos ' : ''}${e.delta > 0 ? '+' : ''}${e.delta} un.)` : '';
    return `${stockLabel(e.old_value)} → ${stockLabel(e.new_value)}${units}`;
  }
  if (e.type === 'removed') return `Esgotado ou retirado${e.old_value != null ? `; último stock: ${stockLabel(e.old_value)}` : ''}`;
  return '';
}

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  tree: '<path d="M4 5h16M4 12h10M4 19h6"/>',
  tag: '<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  percent: '<path d="m19 5-14 14"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>',
  store: '<path d="M4 9v11h16V9M3 4h18l1 5H2zM9 20v-6h6v6"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 21h16"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  phone: '<path d="M5 3h4l2 5-3 2a12 12 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z"/>',
  pin: '<path d="M12 22s7-7 7-12a7 7 0 1 0-14 0c0 5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
};

export const helpers = {
  kz, kzShort, num, pct, date, ago, stockLabel, eventLabel, eventTone, eventDetail,
  eq: (a, b) => a === b,
  gt: (a, b) => a > b,
  or: (a, b) => a || b,
  json: (v) => JSON.stringify(v),
  icon: (name, cls) => new Handlebars.SafeString(
    `<svg aria-hidden="true" class="${typeof cls === 'string' ? cls : 'h-4 w-4'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`,
  ),
  /** Miniatura redimensionada pela CDN da VTEX (o original pode ter vários MB). */
  thumb: (url, size) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) return '';
    return url.replace(/\/arquivos\/ids\/(\d+)\//, `/arquivos/ids/$1-${size}-${size}/`);
  },
  safeUrl: (url) => (typeof url === 'string' && url.startsWith('https://') ? url : '#'),
  stockTone: (p) => {
    if (!p.is_available) return 'critical';
    if (p.stock_known && p.available_qty <= config.lowStockAt) return 'serious';
    return 'good';
  },
  stockText: (p) => {
    if (!p.active) return 'Fora do catálogo';
    if (!p.is_available) return 'Esgotado';
    if (p.stock_known && p.available_qty <= config.lowStockAt) return 'Stock baixo';
    return 'Disponível';
  },
  stockPct: (qty) => Math.min(100, Math.round(((qty || 0) / config.stockCap) * 100)),
  /** Link que mantém os filtros atuais, alterando só os indicados. */
  link: (base, query, options) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) if (v) params.set(k, v);
    for (const [k, v] of Object.entries(options.hash)) { if (v === '' || v == null) params.delete(k); else params.set(k, v); }
    const s = params.toString();
    return s ? `${base}?${s}` : base;
  },
  sortLink: (base, query, key) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) if (v) params.set(k, v);
    params.set('dir', query?.sort === key && query?.dir !== 'desc' ? 'desc' : 'asc');
    params.set('sort', key);
    params.delete('page');
    return `${base}?${params}`;
  },
  sortMark: (query, key) => (query?.sort === key ? (query?.dir === 'desc' ? '↓' : '↑') : ''),
  add: (a, b) => a + b,
};

/** Prepara linhas para barras ordenadas, com a largura relativa ao maior valor. */
export function toBars(rows, value, label, display, href) {
  const max = Math.max(...rows.map(value), 0) || 1;
  return rows.map((r) => ({
    label: label(r), display: display(r), href: href?.(r), value: value(r),
    width: Math.max(value(r) > 0 ? 1 : 0, (value(r) / max) * 100).toFixed(1),
  }));
}
