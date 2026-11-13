import fs from 'node:fs';
import { config } from './config.js';
import { createFrameStream } from './frameStream.js';

export const ACTIVITY_FILE = 'activity.ndjson';
export const FRAME_FILE = 'frame.jpg';
const SNAPSHOT_INTERVAL_MS = 1000; // imagem guardada para quem abrir a página depois do fim

/**
 * Regista o que o scraper está a fazer, para o dashboard acompanhar a partir de outro processo.
 * Observar nunca pode estragar a recolha: qualquer falha de escrita é ignorada.
 */
export class Activity {
  constructor({ runId, trigger, live }) {
    this.dir = config.liveDir;
    this.file = `${this.dir}/${ACTIVITY_FILE}`;
    this.lastSnapshotAt = 0;
    this.lastFrame = null;
    this.stream = null;
    const start = this.line('start', `Execução #${runId} iniciada`, { runId, trigger, live });
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.rmSync(`${this.dir}/${FRAME_FILE}`, { force: true });
      // Um ficheiro novo (inode novo) indica a quem acompanha que começou outra execução.
      fs.writeFileSync(`${this.file}.tmp`, start);
      fs.renameSync(`${this.file}.tmp`, this.file);
      if (live) this.stream = createFrameStream(this.dir);
    } catch { /* ver nota da classe */ }
  }

  line(kind, text, extra) {
    return `${JSON.stringify({ at: new Date().toISOString(), kind, text, ...extra })}\n`;
  }

  emit(kind, text, extra) {
    try { fs.appendFileSync(this.file, this.line(kind, text, extra)); } catch { /* ver nota da classe */ }
  }

  frame(base64) {
    try {
      this.lastFrame = Buffer.from(base64, 'base64');
      this.stream?.send(this.lastFrame);
      if (Date.now() - this.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) this.saveSnapshot();
    } catch { /* ver nota da classe */ }
  }

  saveSnapshot() {
    if (!this.lastFrame) return;
    this.lastSnapshotAt = Date.now();
    const target = `${this.dir}/${FRAME_FILE}`;
    fs.writeFileSync(`${target}.tmp`, this.lastFrame);
    fs.renameSync(`${target}.tmp`, target); // quem lê nunca vê uma imagem a meio
  }

  close() {
    try { this.saveSnapshot(); this.stream?.close(); } catch { /* ver nota da classe */ }
  }
}

export const nullActivity = { emit() {}, frame() {}, close() {} };
