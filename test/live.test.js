import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSameOriginRequest as ok } from '../src/web/live.js';

const local = 'http://127.0.0.1:3000';
const host = '127.0.0.1:3000';

test('aceita o formulário do próprio dashboard', () => {
  assert.equal(ok({ host, origin: local, fetchSite: 'same-origin', bindHost: '127.0.0.1' }), true);
});
test('recusa pedidos vindos de outro site', () => {
  assert.equal(ok({ host, origin: 'https://evil.example', fetchSite: 'cross-site', bindHost: '127.0.0.1' }), false);
  assert.equal(ok({ host, origin: 'https://evil.example', bindHost: '127.0.0.1' }), false);
});
test('recusa origem nula (iframe isolado)', () => {
  assert.equal(ok({ host, origin: 'null', bindHost: '127.0.0.1' }), false);
});
test('recusa DNS rebinding quando o servidor é local', () => {
  assert.equal(ok({ host: 'evil.example:3000', origin: 'http://evil.example:3000', fetchSite: 'same-origin', bindHost: '127.0.0.1' }), false);
});
test('aceita outro nome quando o servidor foi aberto à rede', () => {
  assert.equal(ok({ host: '192.168.1.5:3000', origin: 'http://192.168.1.5:3000', fetchSite: 'same-origin', bindHost: '0.0.0.0' }), true);
});

test('o vídeo reconstrói imagens que chegam partidas em qualquer ponto', async () => {
  const { FrameParser, encodeFrame } = await import('../src/frameStream.js');
  const a = encodeFrame(Buffer.from('imagem-a'));
  const b = encodeFrame(Buffer.from('imagem-b-maior'));
  const all = Buffer.concat([a, b]);
  for (let cut = 1; cut < all.length; cut++) {
    const p = new FrameParser();
    const frames = [...p.push(all.subarray(0, cut)), ...p.push(all.subarray(cut))];
    assert.deepEqual(frames.map((f) => f.subarray(4).toString()), ['imagem-a', 'imagem-b-maior']);
  }
});
test('o vídeo recusa um tamanho de imagem inválido', async () => {
  const { FrameParser } = await import('../src/frameStream.js');
  assert.throws(() => new FrameParser(10).push(Buffer.from([0xff, 0xff, 0xff, 0xff])));
});
