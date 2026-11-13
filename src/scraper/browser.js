import fs from 'node:fs';
import puppeteer from 'puppeteer';
import { nullActivity } from '../activity.js';
import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BLOCKED = new Set(['image', 'media', 'font', 'stylesheet']);
const READING_ROWS_PER_BATCH = 12;
const READING_SCROLL_MS = 4000; // um pouco mais do que um pedido costuma demorar, para não haver paragens
const CHROME_PATHS =['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const findChrome = () => process.env.ANDRA_CHROME || CHROME_PATHS.find((p) => fs.existsSync(p));

export class SiteSession {
  static async open({ log = console.log, activity = nullActivity, live = false } = {}) {
    const args = process.env.ANDRA_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];
    const browser = await puppeteer.launch({ headless: true, args, executablePath: findChrome() });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });
      // O site é pesado: não descarregamos o que não é necessário para extrair dados.
      // Numa execução acompanhada carrega-se tudo, para o ecrã mostrar o site como ele é.
      await page.setRequestInterception(true);
      const session = new SiteSession(browser, page, log, activity, live);
      page.on('request', (req) => (session.lightMode && BLOCKED.has(req.resourceType()) ? req.abort() : req.continue()));
      if (live) {
        // Um separador vazio sai preto na transmissão, e o site pode demorar a pintar a primeira imagem.
        await page.setContent('<!doctype html><html style="background:#fff"><body></body></html>');
        await session.startScreencast();
        await session.hud('A abrir ncrangola.com');
      }
      await session.goto('/');
      return session;
    } catch (e) {
      // Quem chamou não recebe a sessão: sem isto, o Chrome ficava aberto e prendia o processo.
      await browser.close().catch(() => {});
      throw e;
    }
  }

  constructor(browser, page, log, activity = nullActivity, live = false) {
    this.browser = browser; this.page = page; this.log = log; this.activity = activity; this.live = live;
    this.lightMode = !live;
  }

  async startScreencast() {
    const cdp = await this.page.createCDPSession();
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      this.activity.frame(data);
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    // Cada imagem é transmitida assim que o Chrome a produz.
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1366, maxHeight: 900, everyNthFrame: 2 });
  }

  /** Etiqueta dentro do browser observado, porque durante os pedidos internos a página não muda. */
  async hud(text, percent = null) {
    if (!this.live) return;
    await this.page.evaluate((t, pct) => {
      let el = document.getElementById('__andra_hud');
      if (!el) {
        el = document.createElement('div');
        el.id = '__andra_hud';
        Object.assign(el.style, {
          position: 'fixed', left: '16px', bottom: '16px', zIndex: 2147483647, maxWidth: '70vw', minWidth: '320px', pointerEvents: 'none',
          background: '#1a1a18', color: '#fff', font: '600 15px system-ui, sans-serif', padding: '10px 14px',
          borderRadius: '10px', borderLeft: '5px solid #ea580c', boxShadow: '0 4px 16px rgba(0,0,0,.3)',
        });
        const label = document.createElement('div');
        const track = document.createElement('div');
        const fill = document.createElement('div');
        Object.assign(track.style, { height: '4px', marginTop: '8px', borderRadius: '2px', background: 'rgba(255,255,255,.2)', display: 'none' });
        Object.assign(fill.style, { height: '100%', width: '0', borderRadius: '2px', background: '#ea580c', transition: 'width .6s linear' });
        track.append(fill);
        el.append(label, track);
        document.documentElement.appendChild(el);
      }
      const [label, track] = el.children;
      label.textContent = `AndraScrapy · ${t}`;
      track.style.display = pct == null ? 'none' : 'block';
      if (pct != null) track.firstChild.style.width = `${pct}%`;
    }, text, percent).catch(() => {});
  }

  /**
   * Painel com alguns dos dados acabados de ler, a deslizar sobre o site. Só usa texto já recebido, sem novos
   * pedidos. A animação corre no compositor do Chrome, por isso não pára enquanto a página processa respostas.
   */
  async showReading(title, rows) {
    if (!this.live || !rows.length) return;
    const step = Math.max(1, rows.length / READING_ROWS_PER_BATCH);
    const sample = [];
    for (let i = 0; i < rows.length; i += step) sample.push(rows[Math.floor(i)]);
    await this.page.evaluate((heading, items, duration) => {
      const ROW = 46;
      let r = window.__andraReader;
      if (!r) {
        const box = document.createElement('div');
        Object.assign(box.style, {
          position: 'fixed', top: '16px', right: '16px', bottom: '16px', width: '400px', zIndex: 2147483646, overflow: 'hidden',
          pointerEvents: 'none', background: 'rgba(26,26,24,.94)', color: '#fff', borderRadius: '12px',
          font: '13px system-ui, sans-serif', boxShadow: '0 8px 28px rgba(0,0,0,.35)',
        });
        const head = document.createElement('div');
        Object.assign(head.style, { padding: '12px 14px', fontWeight: '700', borderBottom: '1px solid rgba(255,255,255,.15)' });
        const view = document.createElement('div');
        Object.assign(view.style, { position: 'absolute', top: '44px', bottom: '0', left: '0', right: '0', overflow: 'hidden' });
        const list = document.createElement('div');
        Object.assign(list.style, { position: 'absolute', left: '0', right: '0', top: '0', willChange: 'transform' });
        view.append(list);
        box.append(head, view);
        document.documentElement.appendChild(box);
        r = { head, view, list, count: 0 };
        window.__andraReader = r;
      }
      r.head.textContent = heading;
      for (const item of items) {
        const row = document.createElement('div');
        Object.assign(row.style, {
          position: 'absolute', left: '0', right: '0', top: `${r.count * ROW}px`, height: `${ROW}px`, padding: '6px 14px',
          boxSizing: 'border-box', borderBottom: '1px solid rgba(255,255,255,.08)',
        });
        const name = document.createElement('div');
        Object.assign(name.style, { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
        name.textContent = item.title;
        const detail = document.createElement('div');
        Object.assign(detail.style, { color: '#fdba74', fontWeight: '600', fontSize: '12px' });
        detail.textContent = item.detail;
        row.append(name, detail);
        r.list.append(row);
        r.count++;
      }
      while (r.list.childElementCount > 80) r.list.firstElementChild.remove();
      // Continua a partir da posição atual, para o movimento nunca dar saltos.
      const from = new DOMMatrixReadOnly(getComputedStyle(r.list).transform).m42;
      const to = -Math.max(0, r.count * ROW - r.view.clientHeight + ROW);
      r.list.getAnimations().forEach((a) => a.cancel());
      r.list.style.transform = `translateY(${to}px)`;
      r.list.animate([{ transform: `translateY(${from}px)` }, { transform: `translateY(${to}px)` }], { duration, easing: 'linear' });
    }, title, sample, READING_SCROLL_MS).catch(() => {});
  }

  async phase(key, text) {
    this.activity.emit('phase', text, { phase: key });
    await this.hud(text);
  }

  async progress(phase, done, total, text) {
    this.activity.emit('progress', text, { phase, done, total });
    await this.hud(total ? `${text} (${done} de ${total})` : text, total ? Math.min(100, (done / total) * 100) : null);
  }

  /** Clica num elemento, registando onde clicou e marcando o ponto no ecrã acompanhado. */
  async click(handle, label) {
    await handle.scrollIntoView();
    const box = await handle.boundingBox();
    if (!box) throw new Error(`${label} não está visível`);
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    this.activity.emit('click', `Clicou em "${label}"`, { x, y });
    if (this.live) {
      await this.page.evaluate((cx, cy) => {
        const m = document.createElement('div');
        Object.assign(m.style, {
          position: 'fixed', left: `${cx - 18}px`, top: `${cy - 18}px`, width: '36px', height: '36px', borderRadius: '50%',
          border: '3px solid #ea580c', background: 'rgba(234,88,12,.25)', zIndex: 2147483647, pointerEvents: 'none',
        });
        document.documentElement.appendChild(m);
        setTimeout(() => m.remove(), 1500);
      }, x, y).catch(() => {});
    }
    await handle.click();
  }

  async goto(pathname, { settle = false } = {}) {
    const url = new URL(pathname, config.baseUrl).href;
    const started = Date.now();
    this.activity.emit('navigate', `A abrir ${url}`, { url });
    // Numa execução acompanhada carrega-se tudo, o que numa ligação lenta pode passar de um minuto.
    let received = 0;
    const onFinished = () => { received++; };
    const ticker = this.live && setInterval(() => {
      this.activity.emit('progress', `A carregar a página: ${received} ficheiros recebidos`);
    }, 5000);
    if (this.live) this.page.on('requestfinished', onFinished);
    let res;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          res = await this.page.goto(url, {
            waitUntil: settle ? 'networkidle2' : 'domcontentloaded', timeout: this.live ? 240_000 : 90_000,
          });
          break;
        } catch (e) {
          // Falhas de rede momentâneas (ex.: DNS) não devem deitar abaixo a execução inteira.
          if (attempt >= config.retries || !String(e.message).includes('net::')) throw e;
          const wait = 3000 * 2 ** attempt;
          this.activity.emit('warn', `Não foi possível abrir a página (${e.message.split(' at ')[0]}). Nova tentativa em ${wait / 1000} s`);
          await sleep(wait);
        }
      }
    } finally {
      clearInterval(ticker);
      this.page.off('requestfinished', onFinished);
    }
    const http = res ? `HTTP ${res.status()}, ` : '';
    this.activity.emit('loaded', `Página aberta (${http}${((Date.now() - started) / 1000).toFixed(1)} s)`, { url });
    return res?.status();
  }

  logRequest(method, pathname, status, started) {
    this.activity.emit('request', `${method} ${pathname.slice(0, 90)}`, { status, ms: Date.now() - started });
  }

  /** Pedido feito dentro da página, com a mesma sessão/cookies do browser. */
  async request(pathname, accept = 'application/json') {
    let lastError;
    for (let attempt = 0; attempt <= config.retries; attempt++) {
      if (attempt) await sleep(1500 * 2 ** (attempt - 1));
      const started = Date.now();
      try {
        const r = await this.page.evaluate(async (url, accept) => {
          const res = await fetch(url, { headers: { accept }, credentials: 'same-origin' });
          return { status: res.status, resources: res.headers.get('resources'), body: await res.text() };
        }, pathname, accept);
        this.logRequest('GET', pathname, r.status, started);
        if (r.status === 429 || r.status >= 500) { lastError = new Error(`HTTP ${r.status} em ${pathname}`); continue; }
        return r;
      } catch (e) {
        lastError = e;
        // A navegação pode ter destruído o contexto; volta à página inicial antes de repetir.
        await this.goto('/').catch(() => {});
      }
    }
    throw lastError;
  }

  async json(pathname) {
    const r = await this.request(pathname);
    if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} em ${pathname}`);
    const total = r.resources?.split('/')[1];
    return { data: JSON.parse(r.body), total: total ? Number(total) : null };
  }

  async postJson(pathname, body) {
    let lastError;
    for (let attempt = 0; attempt <= config.retries; attempt++) {
      if (attempt) await sleep(1500 * 2 ** (attempt - 1));
      const started = Date.now();
      const r = await this.page.evaluate(async (url, payload) => {
        const res = await fetch(url, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' }, body: payload,
        });
        return { status: res.status, body: await res.text() };
      }, pathname, JSON.stringify(body));
      this.logRequest('POST', pathname, r.status, started);
      if (r.status >= 200 && r.status < 300) return JSON.parse(r.body);
      lastError = new Error(`HTTP ${r.status} em ${pathname}`);
      if (r.status !== 429 && r.status < 500) break;
    }
    throw lastError;
  }

  async close() { await this.browser.close().catch(() => {}); }
}

export { sleep };
