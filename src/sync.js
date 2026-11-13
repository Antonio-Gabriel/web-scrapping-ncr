import fs from 'node:fs';
import { Activity } from './activity.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { acquireLock, releaseLock } from './lock.js';
import { SiteSession } from './scraper/browser.js';
import { applyStock, fetchCategoryTree, fetchProducts, fetchRealStock, normalizeProduct } from './scraper/catalog.js';
import { fetchStores } from './scraper/stores.js';

const median = (sorted) => {
  if (!sorted.length) return null;
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
};

/** Aplica uma recolha à base de dados, registando apenas as diferenças como eventos. */
export function applySnapshot(db, runId, { categories, products, stores, complete, remoteTotal }, now = new Date().toISOString()) {
  const stmts = {
    cat: db.prepare(`INSERT INTO categories (id,parent_id,name,url,level,path,first_seen,last_seen) VALUES (@id,@parentId,@name,@url,@level,@path,@now,@now)
      ON CONFLICT(id) DO UPDATE SET parent_id=@parentId,name=@name,url=@url,level=@level,path=@path,last_seen=@now,active=1`),
    brand: db.prepare(`INSERT INTO brands (id,name) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name`),
    getProduct: db.prepare(`SELECT id, active FROM products WHERE id=?`),
    product: db.prepare(`INSERT INTO products (id,name,brand_id,category_id,reference,slug,url,description,image_url,release_date,specs,first_seen,last_seen)
      VALUES (@id,@name,@brandId,@categoryId,@reference,@slug,@url,@description,@imageUrl,@releaseDate,@specs,@now,@now)
      ON CONFLICT(id) DO UPDATE SET name=@name,brand_id=@brandId,category_id=@categoryId,reference=@reference,slug=@slug,url=@url,
        description=@description,image_url=@imageUrl,release_date=@releaseDate,specs=@specs,last_seen=@now,removed_at=NULL,active=1`),
    delPc: db.prepare(`DELETE FROM product_categories WHERE product_id=?`),
    pc: db.prepare(`INSERT OR IGNORE INTO product_categories (product_id,category_id) VALUES (?,?)`),
    cluster: db.prepare(`INSERT INTO clusters (id,name) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name`),
    delPcl: db.prepare(`DELETE FROM product_clusters WHERE product_id=?`),
    pcl: db.prepare(`INSERT OR IGNORE INTO product_clusters (product_id,cluster_id) VALUES (?,?)`),
    getSku: db.prepare(`SELECT * FROM skus WHERE id=?`),
    sku: db.prepare(`INSERT INTO skus (id,product_id,name,ean,reference,image_url,seller,price,list_price,discount_pct,on_promo,price_valid_until,teasers,available_qty,stock_known,raw_qty,is_available,first_seen,last_seen)
      VALUES (@id,@productId,@name,@ean,@reference,@imageUrl,@seller,@price,@listPrice,@discountPct,@onPromo,@priceValidUntil,@teasers,@availableQty,COALESCE(@stockKnown,0),@rawQty,@isAvailable,@now,@now)
      ON CONFLICT(id) DO UPDATE SET product_id=@productId,name=@name,ean=@ean,reference=@reference,image_url=@imageUrl,seller=@seller,price=@price,list_price=@listPrice,
        discount_pct=@discountPct,on_promo=@onPromo,price_valid_until=@priceValidUntil,teasers=@teasers,available_qty=COALESCE(@availableQty,available_qty),stock_known=COALESCE(@stockKnown,stock_known),raw_qty=@rawQty,is_available=@isAvailable,last_seen=@now,active=1`),
    priceHist: db.prepare(`INSERT INTO price_history (sku_id,run_id,at,price,list_price) VALUES (?,?,?,?,?)`),
    stockHist: db.prepare(`INSERT INTO stock_history (sku_id,run_id,at,available_qty,stock_known,is_available) VALUES (?,?,?,?,?,?)`),
    event: db.prepare(`INSERT INTO events (run_id,at,type,product_id,sku_id,old_value,new_value,delta,note) VALUES (?,?,?,?,?,?,?,?,?)`),
    store: db.prepare(`INSERT INTO stores (id,name,kind,address,city,state,country,postal_code,phone,email,lat,lng,hours,source,first_seen,last_seen)
      VALUES (@id,@name,@kind,@address,@city,@state,@country,@postalCode,@phone,@email,@lat,@lng,@hours,@source,@now,@now)
      ON CONFLICT(id) DO UPDATE SET name=@name,kind=@kind,address=@address,city=@city,state=@state,country=@country,postal_code=@postalCode,phone=@phone,email=@email,lat=@lat,lng=@lng,hours=@hours,source=@source,last_seen=@now,active=1`),
  };

  const isBaseline = db.prepare(`SELECT COUNT(*) c FROM products`).get().c === 0;
  const c = { newProducts: 0, removed: 0, price: 0, stock: 0, promo: 0, skus: 0 };
  const ev = (type, productId, skuId, oldV = null, newV = null, delta = null, note = null) =>
    stmts.event.run(runId, now, type, productId, skuId, oldV, newV, delta, note);

  const tx = db.transaction(() => {
    for (const cat of [...categories].sort((a, b) => a.level - b.level)) stmts.cat.run({ ...cat, now });

    for (const p of products) {
      const prev = stmts.getProduct.get(p.id);
      if (p.brandId != null) stmts.brand.run(p.brandId, p.brandName || `Marca ${p.brandId}`);
      stmts.product.run({ ...p, now });
      stmts.delPc.run(p.id);
      for (const id of p.categoryIds) stmts.pc.run(p.id, id);
      stmts.delPcl.run(p.id);
      for (const cl of p.clusters) { stmts.cluster.run(cl.id, cl.name); stmts.pcl.run(p.id, cl.id); }

      if (!prev && !isBaseline) { ev('new_product', p.id, null, null, p.skus[0]?.price ?? null); c.newProducts++; }
      if (prev && !prev.active) ev('reappeared', p.id, null);

      for (const s of p.skus) {
        c.skus++;
        const old = stmts.getSku.get(s.id);
        stmts.sku.run({ ...s, productId: p.id, now });
        if (!old) {
          stmts.priceHist.run(s.id, runId, now, s.price, s.listPrice);
          stmts.stockHist.run(s.id, runId, now, s.availableQty, s.stockKnown, s.isAvailable);
          continue;
        }
        diffSku(old, s, p.id);
      }
    }

    if (complete) {
      // Só uma recolha completa prova que um produto saiu do catálogo.
      const seen = new Set(products.map((p) => p.id));
      const activeCount = db.prepare(`SELECT COUNT(*) c FROM products WHERE active=1`).get().c;
      if (products.length >= activeCount * config.minCoverageForRemoval) {
        for (const { id } of db.prepare(`SELECT id FROM products WHERE active=1`).all()) {
          if (seen.has(id)) continue;
          db.prepare(`UPDATE products SET active=0, removed_at=? WHERE id=?`).run(now, id);
          db.prepare(`UPDATE skus SET active=0 WHERE product_id=?`).run(id);
          // O catálogo só lista produtos disponíveis: sair dele costuma significar esgotado (ou retirado).
          const last = db.prepare(`SELECT available_qty q FROM skus WHERE product_id=? LIMIT 1`).get(id);
          ev('removed', id, null, last?.q ?? null, null, last?.q != null ? -last.q : null);
          c.removed++;
        }
      }
    }

    // Uma fonte que não devolveu nada falhou; não prova que as suas lojas fecharam.
    for (const [source, list] of Map.groupBy(stores, (s) => s.source)) {
      for (const s of list) stmts.store.run({ ...s, now });
      const ids = new Set(list.map((s) => s.id));
      for (const { id } of db.prepare(`SELECT id FROM stores WHERE active=1 AND source=?`).all(source)) {
        if (!ids.has(id)) db.prepare(`UPDATE stores SET active=0 WHERE id=?`).run(id);
      }
    }

    const live = db.prepare(`SELECT s.price, s.discount_pct, s.on_promo, s.is_available, s.stock_known, s.available_qty
      FROM skus s WHERE s.active=1`).all();
    const prices = live.map((s) => s.price).filter((v) => v > 0).sort((a, b) => a - b);
    const promos = live.filter((s) => s.on_promo);
    db.prepare(`UPDATE runs SET finished_at=?, status=?, is_baseline=?, remote_total=?, products_seen=?, skus_seen=?, stores_seen=?,
        new_products=?, removed_products=?, price_changes=?, stock_changes=?, promo_changes=?,
        snap_products=?, snap_skus=?, snap_promos=?, snap_out_of_stock=?, snap_avg_price=?, snap_median_price=?, snap_avg_discount=?, snap_tracked_units=?, snap_low_stock=?
      WHERE id=?`).run(
      new Date().toISOString(), complete ? 'success' : 'partial', isBaseline ? 1 : 0, remoteTotal, products.length, c.skus, stores.length,
      c.newProducts, c.removed, c.price, c.stock, c.promo,
      db.prepare(`SELECT COUNT(*) c FROM products WHERE active=1`).get().c, live.length, promos.length,
      live.filter((s) => !s.is_available).length,
      prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null, median(prices),
      promos.length ? promos.reduce((a, s) => a + s.discount_pct, 0) / promos.length : null,
      live.filter((s) => s.stock_known).reduce((a, s) => a + s.available_qty, 0),
      live.filter((s) => s.is_available && s.stock_known && s.available_qty <= config.lowStockAt).length,
      runId,
    );
  });

  function diffSku(old, s, productId) {
    if (old.price !== s.price || old.list_price !== s.listPrice) {
      stmts.priceHist.run(s.id, runId, now, s.price, s.listPrice);
      if (old.price !== s.price) {
        ev(s.price > old.price ? 'price_up' : 'price_down', productId, s.id, old.price, s.price, s.price - old.price);
        c.price++;
      }
    }
    if (!!old.on_promo !== !!s.onPromo) {
      ev(s.onPromo ? 'promo_start' : 'promo_end', productId, s.id, old.price, s.price, null, s.discountPct ? `${s.discountPct}%` : null);
      c.promo++;
    }
    // Sem leitura de stock nesta execução (ou na anterior) não há comparação possível.
    if (s.availableQty == null) return;
    if (old.available_qty == null) {
      stmts.stockHist.run(s.id, runId, now, s.availableQty, s.stockKnown, s.isAvailable);
      return;
    }
    if (old.available_qty === s.availableQty && old.is_available === s.isAvailable) return;
    stmts.stockHist.run(s.id, runId, now, s.availableQty, s.stockKnown, s.isAvailable);
    const delta = s.availableQty - old.available_qty;
    // De "50+" para um valor exato, a redução real é de pelo menos |delta|.
    const note = !old.stock_known && delta < 0 ? 'pelo menos' : null;
    if (old.is_available && !s.isAvailable) {
      ev('out_of_stock', productId, s.id, old.available_qty, 0, -old.available_qty, note);
    } else if (!old.is_available && s.isAvailable) {
      ev('back_in_stock', productId, s.id, 0, s.availableQty);
    } else {
      ev(delta < 0 ? 'stock_down' : 'stock_up', productId, s.id, old.available_qty, s.availableQty, delta, note);
    }
    c.stock++;
  }

  tx();
  return { ...c, isBaseline };
}

export async function runSync({ trigger = 'manual', log: print = console.log, live = false } = {}) {
  fs.mkdirSync(config.logDir, { recursive: true });
  let log = print;
  const db = openDb();
  if (!acquireLock()) {
    log('Já existe uma sincronização a decorrer; esta execução foi ignorada.');
    db.close();
    return null;
  }
  const started = new Date();
  const runId = db.prepare(`INSERT INTO runs (started_at, trigger) VALUES (?,?)`).run(started.toISOString(), trigger).lastInsertRowid;
  const activity = new Activity({ runId, trigger, live });
  log = (msg) => {
    print(msg);
    const text = msg.trim();
    if (text.startsWith('aviso:')) activity.emit('warn', text.slice(6).trim());
    else if (!text.startsWith('catálogo:')) activity.emit('info', text);
  };
  let session;
  try {
    log(`[${started.toISOString()}] ${config.name}: execução #${runId} (${trigger})`);
    activity.emit('phase', 'A abrir o browser', { phase: 'browser' });
    session = await SiteSession.open({ log, activity, live });
    await session.phase('categories', 'A ler as categorias');
    const categories = await fetchCategoryTree(session);
    log(`  categorias: ${categories.length}`);
    await session.phase('products', 'A ler os produtos');
    const { products: raw, remoteTotal, complete } = await fetchProducts(session, log);
    const products = raw.map(normalizeProduct);
    log(`  produtos: ${products.length} (site anuncia ${remoteTotal}, ${complete ? 'completo' : 'parcial'})`);
    await session.phase('stock', 'A confirmar o stock real');
    const skuIds = products.flatMap((p) => p.skus.map((s) => s.id));
    const names = new Map(products.flatMap((p) => p.skus.map((s) => [s.id, p.name])));
    const stock = await fetchRealStock(session, skuIds, log, names);
    applyStock(products, stock);
    log(`  stock real lido para ${stock.size}/${skuIds.length} SKUs`);
    await session.phase('stores', 'A ler as lojas');
    const stores = await fetchStores(session, log);
    log(`  lojas: ${stores.length}`);
    await session.phase('save', 'A comparar e a guardar');
    const r = applySnapshot(db, runId, { categories, products, stores, complete, remoteTotal });
    log(`  ${r.isBaseline ? 'carga inicial' : 'alterações'}: novos=${r.newProducts} removidos=${r.removed} preços=${r.price} stock=${r.stock} promoções=${r.promo}`);
    const seconds = Math.round((Date.now() - started) / 1000);
    log(`  concluído em ${seconds}s`);
    await session.hud(`Concluído em ${seconds} s`, 100);
    if (live) await new Promise((resolve) => setTimeout(resolve, 800)); // deixa ver a última imagem
    activity.emit('done', `Concluída em ${seconds} s: ${r.newProducts} novos, ${r.removed} removidos, ${r.price} preços, ${r.stock} stock, ${r.promo} promoções`, { status: complete ? 'success' : 'partial' });
    return { runId, ...r };
  } catch (e) {
    db.prepare(`UPDATE runs SET status='failed', finished_at=?, error=? WHERE id=?`).run(new Date().toISOString(), String(e.message || e), runId);
    activity.emit('error', `A execução falhou: ${e.message || e}`, { status: 'failed' });
    throw e;
  } finally {
    activity.close();
    await session?.close();
    db.close();
    releaseLock();
  }
}
