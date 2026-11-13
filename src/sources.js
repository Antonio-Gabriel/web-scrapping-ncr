import path from 'node:path';
import { ROOT, config } from './config.js';

const TABLES = ['runs', 'categories', 'brands', 'products', 'skus', 'product_categories', 'clusters',
  'product_clusters', 'stores', 'price_history', 'stock_history', 'events'];

/** Nomes das tabelas de uma fonte: cada loja tem as suas, com as mesmas colunas. */
export const tablesFor = (prefix) => Object.fromEntries(TABLES.map((t) => [t, `${prefix}${t}`]));

const define = (s) => ({
  ...s,
  T: tablesFor(s.prefix),
  lockPath: path.join(ROOT, 'data', `.sync${s.prefix ? `-${s.key}` : ''}.lock`),
  // Junto da base de dados, para que testes com outra base não toquem na pasta real.
  liveDir: path.join(path.dirname(config.dbPath), s.prefix ? `live-${s.key}` : 'live'),
});

export const SOURCES = {
  ncr: define({
    key: 'ncr', name: 'NCR Angola', short: 'NCR', prefix: '', baseUrl: 'https://www.ncrangola.com', cronMinute: 0,
    // A NCR permite ler a quantidade (até 50); tem lojas físicas e pontos de levantamento.
    hasQuantity: true, hasStores: true,
    phases: [['browser', 'Abrir o site'], ['categories', 'Categorias'], ['products', 'Produtos'], ['stock', 'Stock real'], ['stores', 'Lojas'], ['save', 'Guardar']],
  }),
  qr: define({
    key: 'qr', name: 'Que Rápido Angola', short: 'Que Rápido', prefix: 'q_', baseUrl: 'https://www.querapidoangola.com', cronMinute: 30,
    // A loja só publica o estado do stock (em stock, por encomenda, esgotado), não a quantidade.
    hasQuantity: false, hasStores: false,
    phases: [['browser', 'Abrir o site'], ['categories', 'Categorias'], ['products', 'Produtos'], ['images', 'Imagens'], ['save', 'Guardar']],
  }),
};

export const SOURCE_LIST = Object.values(SOURCES);
export const sourceFor = (key) => SOURCES[key] || SOURCES.ncr;
