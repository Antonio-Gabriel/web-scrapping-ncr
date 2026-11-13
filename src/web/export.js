import ExcelJS from 'exceljs';
import puppeteer from 'puppeteer';
import { findChrome } from '../scraper/browser.js';
import { availabilityText, eventDetail, eventLabel, stockLabel } from './format.js';

export const FORMATS = {
  csv: { type: 'text/csv; charset=utf-8', ext: 'csv' },
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  json: { type: 'application/json; charset=utf-8', ext: 'json' },
  pdf: { type: 'application/pdf', ext: 'pdf' },
};
export const MAX_ROWS = 25_000;

const DATE = new Intl.DateTimeFormat('pt-PT', { timeZone: 'Africa/Luanda', dateStyle: 'short', timeStyle: 'short' });
const MONEY = new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' });

/** Colunas de cada conjunto de dados. "type" define a forma de cada valor em Excel, JSON e PDF. */
export const DATASETS = {
  produtos: {
    title: 'Produtos',
    columns: [
      { key: 'loja', label: 'Loja', width: 16 },
      { key: 'id', label: 'ID', type: 'int', width: 9 },
      { key: 'produto', label: 'Produto', width: 48 },
      { key: 'referencia', label: 'Referência', width: 16 },
      { key: 'marca', label: 'Marca', width: 16 },
      { key: 'categoria', label: 'Categoria', width: 36 },
      { key: 'preco', label: 'Preço (Kz)', type: 'money', width: 14 },
      { key: 'preco_tabela', label: 'Preço de tabela (Kz)', type: 'money', width: 14 },
      { key: 'desconto_pct', label: 'Desconto (%)', type: 'pct', width: 11 },
      { key: 'stock', label: 'Stock', width: 14 },
      { key: 'disponivel', label: 'Disponível', type: 'bool', width: 10 },
      { key: 'url', label: 'Endereço', type: 'url', width: 40 },
    ],
    map: (r, src) => ({
      loja: src.name, id: r.id, produto: r.name, referencia: r.reference, marca: r.brand, categoria: r.category_path,
      preco: r.price, preco_tabela: r.list_price, desconto_pct: r.discount_pct,
      stock: r.availability ? availabilityText(r.availability) : stockLabel(r.available_qty),
      disponivel: !!r.is_available, url: r.url,
    }),
  },
  alteracoes: {
    title: 'Alterações de stock, preço e promoções',
    columns: [
      { key: 'loja', label: 'Loja', width: 16 },
      { key: 'data', label: 'Data', type: 'date', width: 17 },
      { key: 'tipo', label: 'Alteração', width: 22 },
      { key: 'produto_id', label: 'ID do produto', type: 'int', width: 11 },
      { key: 'produto', label: 'Produto', width: 48 },
      { key: 'detalhe', label: 'Detalhe', width: 40 },
      { key: 'antes', label: 'Antes', type: 'number', width: 12 },
      { key: 'depois', label: 'Depois', type: 'number', width: 12 },
      { key: 'diferenca', label: 'Diferença', type: 'number', width: 12 },
    ],
    map: (e, src) => ({
      loja: src.name, data: e.at, tipo: eventLabel(e.type), produto_id: e.product_id, produto: e.product_name,
      detalhe: eventDetail(e), antes: e.old_value, depois: e.new_value, diferenca: e.delta,
    }),
  },
};

const text = (v, col) => {
  if (v == null || v === '') return '';
  if (col.type === 'money') return MONEY.format(v);
  if (col.type === 'pct') return v ? `${String(v).replace('.', ',')}%` : '';
  if (col.type === 'bool') return v ? 'Sim' : 'Não';
  if (col.type === 'date') return DATE.format(new Date(v));
  return String(v);
};

function toCsv(ds, rows) {
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // impede a execução de fórmulas ao abrir na folha de cálculo
    return `"${s.replace(/"/g, '""')}"`;
  };
  const value = (v, c) => (c.type === 'bool' ? (v ? 'Sim' : 'Não') : c.type === 'date' && v ? DATE.format(new Date(v)) : v);
  const lines = [ds.columns.map((c) => cell(c.label)).join(';'), ...rows.map((r) => ds.columns.map((c) => cell(value(r[c.key], c))).join(';'))];
  // BOM e ";" para o Excel em português abrir os acentos e as colunas corretamente.
  return Buffer.from(`﻿${lines.join('\n')}\n`, 'utf8');
}

function toJson(ds, rows, meta) {
  return Buffer.from(JSON.stringify({ ...meta, conjunto: ds.title, total: rows.length, colunas: ds.columns.map((c) => ({ chave: c.key, nome: c.label })), dados: rows }, null, 2));
}

async function toXlsx(ds, rows, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AndraScrapy';
  wb.created = new Date(meta.gerado_em);
  const ws = wb.addWorksheet(ds.title.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = ds.columns.map((c) => ({ header: c.label, key: c.key, width: c.width }));
  for (const r of rows) {
    ws.addRow(Object.fromEntries(ds.columns.map((c) => {
      const v = r[c.key];
      if (c.type === 'bool') return [c.key, v ? 'Sim' : 'Não'];
      if (c.type === 'date') return [c.key, v ? new Date(v) : null];
      if (c.type === 'pct') return [c.key, v != null ? v / 100 : null];
      if (c.type === 'url' && v) return [c.key, { text: v, hyperlink: v }];
      return [c.key, v ?? null];
    })));
  }
  ds.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.type === 'money') col.numFmt = '#,##0.00 "Kz"';
    if (c.type === 'pct') col.numFmt = '0.0%';
    if (c.type === 'date') col.numFmt = 'dd/mm/yyyy hh:mm';
  });
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEA580C' } };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ds.columns.length } };
  const info = wb.addWorksheet('Sobre');
  info.addRows([['AndraScrapy'], ['Conjunto', ds.title], ['Loja', meta.loja], ['Filtros', meta.filtros || 'nenhum'],
    ['Gerado em', DATE.format(new Date(meta.gerado_em))], ['Linhas', rows.length]]);
  info.getColumn(1).width = 14; info.getColumn(2).width = 60; info.getRow(1).font = { bold: true, size: 14 };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let pdfBusy = Promise.resolve();
/** PDF desenhado pelo Chrome a partir de uma tabela HTML. Um de cada vez, para não abrir vários browsers. */
function toPdf(ds, rows, meta) {
  const job = pdfBusy.then(async () => {
    const cols = ds.columns.filter((c) => c.type !== 'url');
    const numeric = (c) => ['money', 'pct', 'int', 'number'].includes(c.type);
    const body = rows.map((r) => `<tr>${cols.map((c) => `<td class="${numeric(c) ? 'n' : ''}">${esc(text(r[c.key], c))}</td>`).join('')}</tr>`).join('');
    const html = `<!doctype html><html lang="pt"><head><meta charset="utf-8"><style>
      body{font:7.6pt/1.35 system-ui,sans-serif;color:#1a1a18;margin:0}h1{font-size:14pt;margin:0 0 1mm}p{margin:0 0 3mm;color:#52514e}
      table{width:100%;border-collapse:collapse}thead{display:table-header-group}th{background:#ea580c;color:#fff;text-align:left;padding:1.4mm 1.6mm;font-weight:600}
      td{border-bottom:.3mm solid #e8e7e2;padding:1.1mm 1.6mm;vertical-align:top}tr:nth-child(even) td{background:#faf9f7}.n{text-align:right;white-space:nowrap}tr{break-inside:avoid}
      </style></head><body><h1>${esc(ds.title)} · ${esc(meta.loja)}</h1>
      <p>${esc(`${rows.length.toLocaleString('pt-PT')} linhas · gerado em ${DATE.format(new Date(meta.gerado_em))} · filtros: ${meta.filtros || 'nenhum'}`)}</p>
      <table><thead><tr>${cols.map((c) => `<th class="${numeric(c) ? 'n' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></body></html>`;
    const browser = await puppeteer.launch({ headless: true, executablePath: findChrome(), args: process.env.ANDRA_NO_SANDBOX === '1' ? ['--no-sandbox'] : [] });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load', timeout: 120_000 });
      return Buffer.from(await page.pdf({
        format: 'A4', landscape: true, printBackground: true, margin: { top: '10mm', bottom: '12mm', left: '8mm', right: '8mm' },
        displayHeaderFooter: true, headerTemplate: '<span></span>',
        footerTemplate: '<div style="width:100%;font:7pt Arial;color:#75746e;padding:0 8mm;display:flex;justify-content:space-between"><span>AndraScrapy</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
        timeout: 180_000,
      }));
    } finally {
      await browser.close();
    }
  });
  pdfBusy = job.catch(() => {});
  return job;
}

export async function render(fmt, ds, rows, meta) {
  if (fmt === 'csv') return toCsv(ds, rows);
  if (fmt === 'json') return toJson(ds, rows, meta);
  if (fmt === 'xlsx') return toXlsx(ds, rows, meta);
  return toPdf(ds, rows, meta);
}

