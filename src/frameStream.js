import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const STREAM_MAGIC = Buffer.from('ANDRA1\n');
export const STREAM_FILE = 'stream.json';

/** Formato do vídeo: 4 bytes com o tamanho (big-endian), seguidos da imagem JPEG. */
export function encodeFrame(jpeg) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(jpeg.length);
  return Buffer.concat([head, jpeg]);
}

/**
 * Canal local entre o scraper e o dashboard, sem passar pelo disco.
 * Um espectador lento perde imagens em vez de atrasar a recolha ou ver o passado.
 */
export function createFrameStream(dir) {
  const clients = new Set();
  let last = null;
  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    socket.on('close', () => clients.delete(socket));
    socket.write(STREAM_MAGIC);
    if (last) socket.write(last);
    clients.add(socket);
  });
  const file = path.join(dir, STREAM_FILE);
  server.on('error', () => {});
  server.listen(0, '127.0.0.1', () => {
    try { fs.writeFileSync(file, JSON.stringify({ port: server.address().port, pid: process.pid })); } catch { /* sem vídeo */ }
  });
  return {
    send(jpeg) {
      last = encodeFrame(jpeg);
      for (const socket of clients) if (!socket.writableNeedDrain) socket.write(last);
    },
    close() {
      fs.rmSync(file, { force: true });
      for (const socket of clients) socket.destroy();
      server.close();
    },
  };
}

/** Separa imagens completas de pedaços de dados, que podem chegar partidos em qualquer ponto. */
export class FrameParser {
  constructor(maxBytes = 20 * 1024 * 1024) { this.buf = Buffer.alloc(0); this.maxBytes = maxBytes; }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > this.maxBytes) throw new Error('Imagem com tamanho inválido');
      if (this.buf.length < 4 + len) break;
      frames.push(this.buf.subarray(0, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
    return frames;
  }
}
