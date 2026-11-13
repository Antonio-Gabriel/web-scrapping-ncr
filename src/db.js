import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL, finished_at TEXT,
  trigger TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',           -- running | success | partial | failed
  is_baseline INTEGER NOT NULL DEFAULT 0,
  remote_total INTEGER, products_seen INTEGER, skus_seen INTEGER, stores_seen INTEGER,
  new_products INTEGER DEFAULT 0, removed_products INTEGER DEFAULT 0,
  price_changes INTEGER DEFAULT 0, stock_changes INTEGER DEFAULT 0, promo_changes INTEGER DEFAULT 0,
  -- fotografia do catálogo no fim da execução (séries temporais do BI)
  snap_products INTEGER, snap_skus INTEGER, snap_promos INTEGER, snap_out_of_stock INTEGER,
  snap_avg_price REAL, snap_median_price REAL, snap_avg_discount REAL, snap_tracked_units INTEGER, snap_low_stock INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES categories(id),
  name TEXT NOT NULL, url TEXT, level INTEGER NOT NULL, path TEXT NOT NULL,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS brands (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, brand_id INTEGER REFERENCES brands(id),
  category_id INTEGER, reference TEXT, slug TEXT, url TEXT, description TEXT, image_url TEXT,
  release_date TEXT, specs TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, removed_at TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS skus (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT, ean TEXT, reference TEXT, image_url TEXT, seller TEXT,
  price REAL, list_price REAL, discount_pct REAL NOT NULL DEFAULT 0, on_promo INTEGER NOT NULL DEFAULT 0,
  price_valid_until TEXT, teasers TEXT,
  -- available_qty: unidades confirmadas pela simulação do checkout (exatas se stock_known=1, senão "50+").
  -- raw_qty: valor do catálogo, publicado apenas em escalões (1, 10, 100, 99999).
  available_qty INTEGER, stock_known INTEGER NOT NULL DEFAULT 0, raw_qty INTEGER, is_available INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
-- Inclui a categoria final e todos os seus ascendentes, para agregações por qualquer nível.
CREATE TABLE IF NOT EXISTS product_categories (
  product_id INTEGER NOT NULL REFERENCES products(id), category_id INTEGER NOT NULL,
  PRIMARY KEY (product_id, category_id)
);
CREATE TABLE IF NOT EXISTS clusters (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS product_clusters (
  product_id INTEGER NOT NULL REFERENCES products(id), cluster_id INTEGER NOT NULL REFERENCES clusters(id),
  PRIMARY KEY (product_id, cluster_id)
);
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, address TEXT, city TEXT, state TEXT, country TEXT,
  postal_code TEXT, phone TEXT, email TEXT, lat REAL, lng REAL, hours TEXT, source TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sku_id INTEGER NOT NULL REFERENCES skus(id), run_id INTEGER NOT NULL,
  at TEXT NOT NULL, price REAL, list_price REAL
);
CREATE TABLE IF NOT EXISTS stock_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sku_id INTEGER NOT NULL REFERENCES skus(id), run_id INTEGER NOT NULL,
  at TEXT NOT NULL, available_qty INTEGER, stock_known INTEGER, is_available INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES runs(id), at TEXT NOT NULL,
  type TEXT NOT NULL, product_id INTEGER NOT NULL, sku_id INTEGER,
  old_value REAL, new_value REAL, delta REAL, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_skus_product ON skus(product_id);
CREATE INDEX IF NOT EXISTS idx_skus_promo ON skus(on_promo, active);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_pc_category ON product_categories(category_id);
CREATE INDEX IF NOT EXISTS idx_events_at ON events(at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, at DESC);
CREATE INDEX IF NOT EXISTS idx_price_sku ON price_history(sku_id, at);
CREATE INDEX IF NOT EXISTS idx_stock_sku ON stock_history(sku_id, at);
`;

export function openDb({ readonly = false } = {}) {
  if (!readonly) fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath, readonly ? { readonly: true, fileMustExist: true } : {});
  db.pragma('busy_timeout = 15000');
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    // Uma execução interrompida (ex.: máquina desligada) não pode ficar "a correr" para sempre.
    db.prepare(`UPDATE runs SET status='failed', finished_at=?, error='Execução interrompida'
                WHERE status='running' AND started_at < ?`)
      .run(new Date().toISOString(), new Date(Date.now() - 3600_000).toISOString());
  }
  return db;
}
