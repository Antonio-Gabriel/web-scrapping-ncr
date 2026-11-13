import { config } from '../config.js';
import { sleep } from './browser.js';

// API pública que o próprio site usa (WooCommerce Store API). Não está proibida no robots.txt.
const API = '/wp-json/wc/store/v1';
// As imagens são 90% do peso de cada resposta: só se pedem para produtos que ainda não as têm.
const FIELDS = 'id,name,slug,permalink,sku,type,on_sale,prices,is_in_stock,is_on_backorder,is_purchasable,stock_availability,categories,brands';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' };
export const decodeEntities = (s) => (s == null ? s : String(s)
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
  .replace(/\s+/g, ' ').trim());

async function paged(session, path, log, onPage) {
  const all = [];
  let total = null;
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const { data, total: t } = await session.json(`${API}${path}${sep}per_page=${config.qrPageSize}&page=${page}`);
    if (t != null) total = t;
    all.push(...data);
    await onPage?.(all, total, data);
    if (!data.length || data.length < config.qrPageSize || (total != null && all.length >= total) || all.length >= config.qrMaxProducts) break;
    await sleep(config.requestDelayMs);
  }
  return { items: all, total };
}

/** Árvore de categorias com nível e caminho, a partir da relação pai/filho. */
export async function fetchQrCategories(session, log) {
  const { items } = await paged(session, '/products/categories', log);
  const byId = new Map(items.map((c) => [c.id, c]));
  const pathOf = (c, seen = new Set()) => {
    const parent = c.parent && !seen.has(c.parent) ? byId.get(c.parent) : null;
    if (!parent) return [decodeEntities(c.name)];
    seen.add(c.id);
    return [...pathOf(parent, seen), decodeEntities(c.name)];
  };
  return items.map((c) => {
    const p = pathOf(c);
    return { id: c.id, parentId: c.parent && byId.has(c.parent) ? c.parent : null, name: decodeEntities(c.name), url: c.permalink, level: p.length - 1, path: p.join(' › ') };
  });
}

export async function fetchQrProducts(session, log) {
  const { items, total } = await paged(session, `/products?_fields=${FIELDS}`, log, async (all, t, page) => {
    log(`  produtos: ${all.length}/${t ?? '?'}`);
    await session.progress('products', all.length, t, page[0] ? `A ler produtos, por exemplo: ${decodeEntities(page[0].name)}` : 'A ler produtos');
    if (session.live) {
      await session.showReading(`Produtos lidos: ${all.length} de ${t ?? '?'}`, page.map((p) => ({
        title: decodeEntities(p.name),
        detail: `${Number(p.prices?.price || 0).toLocaleString('pt-PT', { useGrouping: 'always' })} Kz · ${availabilityOf(p).label}`,
      })));
    }
  });
  const unique = [...new Map(items.map((p) => [p.id, p])).values()];
  return { products: unique, remoteTotal: total, complete: total != null && unique.length >= total };
}

/** Imagens só para os produtos indicados, em lotes, com o filtro "include" da API. */
export async function fetchQrImages(session, ids, log) {
  const images = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const { data } = await session.json(`${API}/products?include=${batch.join(',')}&per_page=50&_fields=id,images`);
      for (const p of data) if (p.images?.[0]) images.set(p.id, p.images[0].thumbnail || p.images[0].src);
    } catch (e) { log(`  aviso: imagens do lote ${i}: ${e.message}`); }
    await session.progress('images', Math.min(i + batch.length, ids.length), ids.length, 'A ler imagens de produtos novos');
    await sleep(config.requestDelayMs);
  }
  return images;
}

export function availabilityOf(p) {
  if (!p.is_in_stock) return { key: 'out_of_stock', label: 'Fora de stock' };
  if (p.is_on_backorder) return { key: 'backorder', label: 'Por encomenda' };
  return { key: 'in_stock', label: 'Em stock' };
}

/** Converte um produto da loja no mesmo modelo usado para a NCR (um produto com um SKU). */
export function normalizeQrProduct(p, categoriesById, image = null) {
  const unit = 10 ** (p.prices?.currency_minor_unit ?? 0);
  const price = p.prices?.price != null ? Number(p.prices.price) / unit : null;
  const list = p.prices?.regular_price ? Number(p.prices.regular_price) / unit : price;
  const onPromo = price > 0 && list > price;
  const cats = (p.categories || []).map((c) => categoriesById.get(c.id)).filter(Boolean);
  const deepest = cats.sort((a, b) => b.level - a.level)[0];
  // Cada categoria do produto conta, com todos os seus ascendentes (para somar por departamento).
  const categoryIds = new Set();
  for (const c of cats) for (let x = c; x; x = x.parentId ? categoriesById.get(x.parentId) : null) categoryIds.add(x.id);
  const avail = availabilityOf(p);
  const brand = p.brands?.[0];
  return {
    id: p.id, name: decodeEntities(p.name), brandId: brand?.id ?? null, brandName: decodeEntities(brand?.name) || null,
    categoryId: deepest?.id ?? null, categoryIds: [...categoryIds],
    reference: p.sku || null, slug: p.slug, url: p.permalink, description: null, imageUrl: image,
    releaseDate: null, specs: null, clusters: [],
    skus: [{
      id: p.id, name: decodeEntities(p.name), ean: null, reference: p.sku || null, imageUrl: image, seller: 'Que Rápido Angola',
      price, listPrice: list, discountPct: onPromo ? Math.round((1 - price / list) * 1000) / 10 : 0, onPromo: onPromo ? 1 : 0,
      priceValidUntil: null, teasers: null, rawQty: null,
      availableQty: null, stockKnown: 0, isAvailable: avail.key === 'out_of_stock' ? 0 : 1, availability: avail.key,
    }],
  };
}
