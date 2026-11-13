import { config } from '../config.js';
import { sleep } from './browser.js';

const SEARCH = '/api/catalog_system/pub/products/search';

export async function fetchCategoryTree(session) {
  const { data } = await session.json('/api/catalog_system/pub/category/tree/5');
  const flat = [];
  const walk = (nodes, parentId, level, trail) => {
    for (const n of nodes) {
      const p = [...trail, n.name];
      flat.push({ id: n.id, parentId, name: n.name, url: n.url, level, path: p.join(' › ') });
      walk(n.children || [], n.id, level + 1, p);
    }
  };
  walk(data, null, 0, []);
  return flat;
}

/** Percorre o catálogo paginado. `complete` indica se a recolha cobriu tudo o que o site anunciou. */
export async function fetchProducts(session, log) {
  const byId = new Map();
  let remoteTotal = null;
  for (let from = 0; ; from += config.pageSize) {
    if (byId.size >= config.maxProducts) break;
    const { data, total } = await session.json(`${SEARCH}?_from=${from}&_to=${from + config.pageSize - 1}`);
    if (total != null) remoteTotal = total;
    for (const p of data) if (byId.size < config.maxProducts) byId.set(String(p.productId), p);
    if (from % 250 === 0) log(`  catálogo: ${byId.size}/${remoteTotal ?? '?'} produtos`);
    await session.progress('products', byId.size, remoteTotal, data[0] ? `A ler produtos, por exemplo: ${data[0].productName}` : 'A ler produtos');
    if (session.live) {
      await session.showReading(`Produtos lidos: ${byId.size} de ${remoteTotal ?? '?'}`, data.map((p) => {
        const price = p.items?.[0]?.sellers?.[0]?.commertialOffer?.Price;
        return { title: p.productName, detail: price != null ? `${price.toLocaleString('pt-PT', { minimumFractionDigits: 2, useGrouping: 'always' })} Kz` : 'Sem preço' };
      }));
    }
    if (!data.length || (remoteTotal != null && from + config.pageSize >= remoteTotal)) break;
    await sleep(config.requestDelayMs);
  }

  // O sitemap lista produtos que a pesquisa por vezes omite; vamos buscar os que faltam.
  const missing = await sitemapSlugsMissing(session, byId, log);
  let recovered = 0;
  for (const slug of missing) {
    if (byId.size >= config.maxProducts) break;
    try {
      const { data } = await session.json(`${SEARCH}/${encodeURIComponent(slug)}/p`);
      if (data[0]) { byId.set(String(data[0].productId), data[0]); recovered++; }
      await session.showReading('A verificar produtos do sitemap', [{ title: slug, detail: data[0] ? 'Recuperado' : 'Fora do catálogo' }]);
    } catch (e) { log(`  aviso: ${slug}: ${e.message}`); }
    await sleep(config.requestDelayMs);
  }
  if (missing.length) log(`  sitemap: ${missing.length} em falta, ${recovered} recuperados`);

  const capped = byId.size >= config.maxProducts;
  const complete = !capped && remoteTotal != null && byId.size >= remoteTotal;
  return { products: [...byId.values()], remoteTotal, complete };
}

async function sitemapSlugsMissing(session, byId, log) {
  try {
    const known = new Set([...byId.values()].map((p) => p.linkText));
    const slugs = new Set();
    for (let i = 0; i < 10; i++) {
      const r = await session.request(`/sitemap/product-${i}.xml`, 'application/xml');
      if (r.status !== 200) break;
      const locs = [...r.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      if (!locs.length) break;
      for (const loc of locs) {
        const m = new URL(loc).pathname.match(/^\/(.+)\/p$/);
        if (m) slugs.add(decodeURIComponent(m[1]));
      }
    }
    return [...slugs].filter((s) => !known.has(s));
  } catch (e) {
    log(`  aviso: sitemap indisponível (${e.message})`);
    return [];
  }
}

/**
 * O catálogo só publica escalões de stock. A simulação do checkout (a mesma que o carrinho usa, sem criar
 * carrinho nem reservar nada) limita a quantidade pedida ao stock real, até ao máximo de 50 por item.
 * Devolve Map(skuId -> unidades); SKUs de lotes que falharam ficam de fora.
 */
export async function fetchRealStock(session, skuIds, log, names = new Map()) {
  const stock = new Map();
  for (let i = 0; i < skuIds.length; i += config.pageSize) {
    const batch = skuIds.slice(i, i + config.pageSize);
    try {
      const items = batch.map((id) => ({ id: String(id), quantity: config.stockCap, seller: '1' }));
      const res = await session.postJson('/api/checkout/pub/orderForms/simulation?sc=1', { items, country: 'AGO' });
      const seen = new Map();
      for (const it of res.items || []) {
        const qty = it.availability === 'withoutStock' ? 0 : it.quantity;
        seen.set(Number(it.id), (seen.get(Number(it.id)) || 0) + qty);
      }
      for (const [id, qty] of seen) stock.set(id, Math.min(qty, config.stockCap));
    } catch (e) { log(`  aviso: stock do lote ${i}: ${e.message}`); }
    const checked = Math.min(i + batch.length, skuIds.length);
    await session.progress('stock', checked, skuIds.length, 'A confirmar o stock real');
    if (session.live) {
      const label = (q) => (q >= config.stockCap ? `${config.stockCap} ou mais unidades` : `${q} un.`);
      await session.showReading(`Stock confirmado: ${checked} de ${skuIds.length}`, batch.filter((id) => stock.has(id))
        .map((id) => ({ title: names.get(id) || `SKU ${id}`, detail: label(stock.get(id)) })));
    }
    await sleep(config.requestDelayMs);
  }
  return stock;
}

/** Junta o stock real aos SKUs. Sem resposta, availableQty fica null e o valor anterior é preservado. */
export function applyStock(products, stock) {
  for (const p of products) {
    for (const s of p.skus) {
      if (!stock.has(s.id)) continue;
      s.availableQty = stock.get(s.id);
      s.stockKnown = s.availableQty < config.stockCap ? 1 : 0;
      if (s.availableQty === 0) s.isAvailable = 0;
    }
  }
  return products;
}

const SPEC_KEYS_EXCLUDED =new Set(['allSpecifications', 'allSpecificationsGroups']);

/** Converte a resposta da VTEX no modelo interno, descartando o que não usamos. */
export function normalizeProduct(p) {
  const specs = {};
  for (const name of p.allSpecifications || []) {
    if (!SPEC_KEYS_EXCLUDED.has(name) && Array.isArray(p[name])) specs[name] = p[name].join(', ');
  }
  const categoryIds = [...new Set((p.categoriesIds || []).flatMap((s) => s.split('/').filter(Boolean).map(Number)))];
  const skus = (p.items || []).map((item) => {
    const seller = item.sellers?.find((s) => s.sellerDefault) || item.sellers?.[0];
    const o = seller?.commertialOffer || {};
    const price = o.Price ?? null;
    const list = o.ListPrice ?? null;
    const onPromo = price > 0 && list > price;
    const qty = o.AvailableQuantity ?? 0;
    const teasers = [...(o.Teasers || []), ...(o.PromotionTeasers || []), ...(o.DiscountHighLight || [])]
      .map((t) => t?.['<Name>k__BackingField'] || t?.Name || t?.name).filter(Boolean);
    return {
      id: Number(item.itemId), name: item.nameComplete || item.name, ean: item.ean || null,
      reference: item.referenceId?.[0]?.Value || null, imageUrl: item.images?.[0]?.imageUrl || null,
      seller: seller?.sellerName || null, price, listPrice: list,
      discountPct: onPromo ? Math.round((1 - price / list) * 1000) / 10 : 0, onPromo: onPromo ? 1 : 0,
      priceValidUntil: o.PriceValidUntil || null, teasers: teasers.length ? JSON.stringify(teasers) : null,
      rawQty: qty, availableQty: null, stockKnown: null, // preenchidos por applyStock
      isAvailable: o.IsAvailable && qty > 0 ? 1 : 0,
    };
  });
  return {
    id: Number(p.productId), name: p.productName, brandId: p.brandId ?? null, brandName: p.brand || null,
    categoryId: p.categoryId ? Number(p.categoryId) : null, categoryIds,
    reference: p.productReference || null, slug: p.linkText, url: p.link,
    description: p.description || null, imageUrl: skus[0]?.imageUrl || null,
    releaseDate: p.releaseDate || null, specs: Object.keys(specs).length ? JSON.stringify(specs) : null,
    clusters: Object.entries(p.productClusters || {}).map(([id, name]) => ({ id: Number(id), name })),
    skus,
  };
}
