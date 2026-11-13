import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  name: 'AndraScrapy',
  baseUrl: 'https://www.ncrangola.com',
  dbPath: process.env.ANDRA_DB || path.join(ROOT, 'data', 'andrascrapy.db'),
  lockPath: path.join(ROOT, 'data', '.sync.lock'),
  liveDir: path.join(path.dirname(process.env.ANDRA_DB || path.join(ROOT, 'data', 'x')), 'live'),
  logDir: path.join(ROOT, 'logs'),
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  maxProducts: Number(process.env.ANDRA_MAX_PRODUCTS || 3000),
  pageSize: 50, // limite por pedido do catálogo VTEX
  requestDelayMs: Number(process.env.ANDRA_DELAY_MS || 600),
  retries: 4,
  // A simulação do checkout só confirma até 50 unidades por item: acima disso o stock é "50+".
  stockCap: 50,
  lowStockAt: 5,
  // Só se marcam produtos como removidos se a recolha cobrir pelo menos esta fração do total anterior.
  minCoverageForRemoval: 0.9,
  // Coordenadas usadas para descobrir pontos de levantamento em Angola.
  storeProbeCoords: [
    ['Luanda', 13.2344, -8.8147], ['Talatona', 13.199, -8.914], ['Benguela', 13.4055, -12.5763],
    ['Lubango', 13.4925, -14.9177], ['Huambo', 15.7392, -12.7761], ['Cabinda', 12.2, -5.55],
    ['Malanje', 16.3416, -9.5402], ['Soyo', 12.3686, -6.1349],
  ],
};
