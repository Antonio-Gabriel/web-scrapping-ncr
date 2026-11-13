import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { ACTIVITY_FILE, FRAME_FILE } from '../activity.js';
import { ROOT, config } from '../config.js';
import { FrameParser, STREAM_FILE, STREAM_MAGIC, encodeFrame } from '../frameStream.js';
import { syncIsRunning } from '../lock.js';

const POLL_MS = 200;
const HUB_POLL_MS = 300;
const HEARTBEAT_MS = 15_000;
const STARTUP_GRACE_MS = 10_000; // o processo novo demora um instante a criar o bloqueio
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

let startingUntil = 0;
const isRunning = () => syncIsRunning() || Date.now() < startingUntil;

/**
 * Bloqueia pedidos vindos de outros sites: sem isto, qualquer página aberta no browser
 * poderia pôr o scraper a correr. Quando o servidor é local, valida também o Host (DNS rebinding).
 */
export function isSameOriginRequest({ host, origin, fetchSite, bindHost = config.host }) {
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, '');
  if (LOCAL_HOSTS.has(bindHost === '127.0.0.1' ? bindHost : '') && !LOCAL_HOSTS.has(hostname)) return false;
  if (fetchSite && fetchSite !== 'same-origin') return false;
  if (origin) {
    try { return new URL(origin).host === host; } catch { return false; }
  }
  return true;
}

function startRun() {
  fs.mkdirSync(config.logDir, { recursive: true });
  const out = fs.openSync(path.join(config.logDir, 'manual.log'), 'a');
  // Processo independente: a recolha continua mesmo que o dashboard seja fechado.
  const child = spawn(process.execPath, ['src/cli/sync.js', '--live'], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: process.env,
  });
  child.unref();
  fs.closeSync(out);
  startingUntil = Date.now() + STARTUP_GRACE_MS;
}

/** Lê o que foi acrescentado ao registo desde a última leitura, apenas até à última linha completa. */
function readNewLines(file, cursor) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { lines: [], reset: false }; }
  let reset = false;
  if (cursor.ino !== stat.ino) {
    // Só é "nova execução" se já estávamos a ler outra; quem acabou de chegar apenas recebe o histórico.
    reset = cursor.ino !== null;
    cursor.ino = stat.ino;
    cursor.offset = 0;
  }
  if (stat.size <= cursor.offset) return { lines: [], reset };
  const buf = Buffer.alloc(stat.size - cursor.offset);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, cursor.offset); } finally { fs.closeSync(fd); }
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return { lines: [], reset };
  cursor.offset += end + 1;
  return { lines: buf.subarray(0, end).toString('utf8').split('\n'), reset };
}

/** Liga-se ao scraper enquanto houver espectadores e reenvia cada imagem assim que chega. */
class FrameHub {
  constructor(dir) {
    this.streamFile = path.join(dir, STREAM_FILE);
    this.snapshotFile = path.join(dir, FRAME_FILE);
    this.viewers = new Set();
    this.socket = null;
    this.port = null;
    this.last = null;
    this.timer = null;
  }

  add(res) {
    this.viewers.add(res);
    const first = this.last ?? this.readSnapshot();
    if (first) res.write(first);
    if (!this.timer) { this.timer = setInterval(() => this.connect(), HUB_POLL_MS); this.connect(); }
  }

  remove(res) {
    this.viewers.delete(res);
    if (this.viewers.size) return;
    clearInterval(this.timer);
    this.timer = null;
    this.socket?.destroy();
    this.last = null; // sem espectadores deixa de estar atualizada; a imagem guardada em disco substitui-a
  }

  readSnapshot() {
    try { return encodeFrame(fs.readFileSync(this.snapshotFile)); } catch { return null; }
  }

  connect() {
    if (this.socket) return;
    let info;
    try { info = JSON.parse(fs.readFileSync(this.streamFile, 'utf8')); } catch { return; }
    if (!info.port) return;
    const socket = net.connect(info.port, '127.0.0.1');
    this.socket = socket;
    const parser = new FrameParser();
    let greeted = false;
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      try {
        let data = chunk;
        if (!greeted) {
          pending = Buffer.concat([pending, chunk]);
          if (pending.length < STREAM_MAGIC.length) return;
          // O ficheiro pode apontar para uma porta antiga, agora usada por outro programa.
          if (!pending.subarray(0, STREAM_MAGIC.length).equals(STREAM_MAGIC)) { socket.destroy(); return; }
          greeted = true;
          this.last = null; // ligação a uma execução: a imagem anterior deixou de valer
          data = pending.subarray(STREAM_MAGIC.length);
        }
        for (const frame of parser.push(data)) this.broadcast(frame);
      } catch { socket.destroy(); }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => { if (this.socket === socket) this.socket = null; });
  }

  broadcast(frame) {
    this.last = Buffer.from(frame);
    // Um espectador atrasado salta imagens, para ver sempre o momento atual.
    for (const res of this.viewers) if (!res.writableNeedDrain) res.write(this.last);
  }
}

export function registerLive(app) {
  const activityFile = path.join(config.liveDir, ACTIVITY_FILE);
  const hub = new FrameHub(config.liveDir);

  app.post('/execucoes/iniciar', (req, res) => {
    const allowed = isSameOriginRequest({
      host: req.get('host'), origin: req.get('origin'), fetchSite: req.get('sec-fetch-site'),
    });
    if (!allowed) return res.status(403).type('text/plain').send('Pedido recusado.');
    // Se já houver uma execução, abre-se o acompanhamento em vez de iniciar outra.
    if (!isRunning()) startRun();
    res.redirect(303, '/execucoes/ao-vivo');
  });

  app.get('/execucoes/ao-vivo', (_req, res) => {
    res.render('ao-vivo', { title: 'Acompanhar ao vivo', running: isRunning() });
  });

  app.get('/execucoes/ao-vivo/video', (req, res) => {
    res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    hub.add(res);
    req.on('close', () => hub.remove(res));
  });

  app.get('/execucoes/ao-vivo/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${data}\n\n`);
    const cursor = { ino: null, offset: 0 };
    let lastRunning = null;
    let lastWrite = Date.now();
    // Numa religação o histórico é reenviado: o registo recomeça, mas a imagem mantém-se.
    send('replay', '{}');

    const tick = () => {
      try {
        const { lines, reset } = readNewLines(activityFile, cursor);
        if (reset) send('reset', '{}');
        for (const line of lines) send('activity', line);
        const running = isRunning();
        if (running !== lastRunning) { lastRunning = running; send('status', JSON.stringify({ running })); }
        if (lines.length || reset) lastWrite = Date.now();
        if (Date.now() - lastWrite > HEARTBEAT_MS) { res.write(': ligado\n\n'); lastWrite = Date.now(); }
      } catch (e) {
        console.error('Acompanhamento ao vivo:', e.message);
      }
    };
    const timer = setInterval(tick, POLL_MS);
    tick();
    req.on('close', () => clearInterval(timer));
  });
}

export { isRunning };
