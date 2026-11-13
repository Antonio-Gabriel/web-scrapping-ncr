import { config } from '../config.js';
import { sleep } from './browser.js';

const slugify = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** A página não indica a cidade: é deduzida pelas coordenadas do mapa de cada loja. */
function nearestCity(lat, lng) {
  if (lat == null) return null;
  const [best] = config.storeProbeCoords
    .map(([label, x, y]) => [label, (x - lng) ** 2 + (y - lat) ** 2])
    .sort((a, b) => a[1] - b[1]);
  return best[0] === 'Talatona' ? 'Luanda' : best[0];
}

/** Lojas físicas: a página /nossas-lojas é renderizada no cliente e só existe depois de correr o JavaScript. */
async function fetchPhysicalStores(session, log) {
  // O mapa incorporado só é montado com os estilos da página carregados.
  session.lightMode = false;
  await session.goto('/nossas-lojas', { settle: true });
  session.lightMode = !session.live;
  const page = session.page;
  const ITEM = '[class*="mapSectionItem"]';
  await page.waitForSelector(`${ITEM} h3`, { timeout: 45_000 });
  await page.waitForSelector('iframe[src*="google.com/maps"]', { timeout: 15_000 }).catch(() => {});

  const raw = await page.evaluate((sel) => {
    const txt = (el, q) => el.querySelector(q)?.textContent.trim() || null;
    const seen = new Set();
    return [...document.querySelectorAll(sel)].map((el) => {
      const name = txt(el, '[class*="mapSectionHeaderTitle"]');
      if (!name || seen.has(name)) return null;
      seen.add(name);
      return {
        name,
        address: txt(el, '[class*="mapSectionHeaderDescription"]'),
        phone: txt(el, '[class*="mapSectionContentPhone"] [class*="mapSectionContentItem"]'),
        hours: txt(el, '[class*="mapSectionContentHours"] [class*="mapSectionContentItem"]'),
      };
    }).filter(Boolean);
  }, ITEM);

  // Selecionar uma loja atualiza o mapa incorporado, de onde se retiram as coordenadas.
  const stores = [];
  for (const s of raw) {
    let lat = null; let lng = null;
    try {
      const handle = await page.evaluateHandle((sel, name) => [...document.querySelectorAll(`${sel} [role="button"]`)]
        .find((b) => b.textContent.includes(name)), ITEM, s.name);
      await session.hud(`A abrir a loja ${s.name}`);
      const el = handle.asElement();
      if (el) await session.click(el, s.name);
      await handle.dispose();
      await sleep(session.live ? 1500 : 500); // dá tempo de ver o clique e o mapa a mudar
      const src = await page.$eval('iframe[src*="google.com/maps"]', (f) => f.src);
      const m = src.match(/!2d(-?[\d.]+)!3d(-?[\d.]+)/);
      if (m) { lng = Number(m[1]); lat = Number(m[2]); }
    } catch (e) { log(`  aviso: coordenadas de ${s.name}: ${e.message}`); }
    stores.push({
      id: `loja-${slugify(s.name)}`, name: s.name, kind: 'Loja física', address: s.address,
      city: nearestCity(lat, lng), state: null, country: 'AGO', postalCode: null,
      phone: s.phone, email: null, lat, lng, hours: s.hours ? JSON.stringify(s.hours) : null, source: 'nossas-lojas',
    });
  }
  // Se o mapa não respondeu aos cliques, todas as lojas teriam o mesmo ponto: é melhor não guardar coordenadas erradas.
  const uniq = new Set(stores.filter((s) => s.lat != null).map((s) => `${s.lat},${s.lng}`));
  if (uniq.size <= 1 && stores.length > 1) for (const s of stores) { s.lat = null; s.lng = null; }
  await session.goto('/');
  return stores;
}

/** Pontos de levantamento publicados pelo checkout da VTEX. */
async function fetchPickupPoints(session, log) {
  const found = new Map();
  for (const [label, lng, lat] of config.storeProbeCoords) {
    try {
      const { data } = await session.json(`/api/checkout/pub/pickup-points?geoCoordinates=${lng};${lat}`);
      for (const { pickupPoint: p } of data.items || []) {
        const a = p.address || {};
        found.set(p.id, {
          id: p.id, name: p.friendlyName, kind: 'Ponto de levantamento',
          address: [a.street, a.number, a.neighborhood].filter(Boolean).join(', ') || null,
          city: a.city || null, state: a.state || null, country: a.country || null,
          postalCode: a.postalCode || null, phone: null, email: null,
          lng: a.geoCoordinates?.[0] ?? null, lat: a.geoCoordinates?.[1] ?? null,
          hours: p.businessHours ? JSON.stringify(p.businessHours) : null, source: 'pickup-points',
        });
      }
    } catch (e) { log(`  aviso: pontos de levantamento perto de ${label}: ${e.message}`); }
    await sleep(config.requestDelayMs);
  }
  return [...found.values()];
}

export async function fetchStores(session, log) {
  let physical = [];
  try { physical = await fetchPhysicalStores(session, log); } catch (e) {
    log(`  aviso: lojas físicas indisponíveis (${e.message})`);
    await session.goto('/').catch(() => {});
  }
  return [...physical, ...(await fetchPickupPoints(session, log))];
}
