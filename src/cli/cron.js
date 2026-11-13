#!/usr/bin/env node
// Instala/remove a tarefa horária no crontab do utilizador, sem tocar nas restantes entradas.
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, config } from '../config.js';

const MARK = '# AndraScrapy';
const readCrontab = () => {
  const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : '';
};
const writeCrontab = (text) => execFileSync('crontab', ['-'], { input: text });
const without = (text) => text.split('\n').filter((l) => !l.includes(MARK)).join('\n').replace(/\n+$/, '');

const action = process.argv[2];
if (action === 'install') {
  const log = path.join(config.logDir, 'cron.log');
  const line = `0 * * * * cd "${ROOT}" && "${process.execPath}" src/cli/sync.js --cron >> "${log}" 2>&1 ${MARK}`;
  const base = without(readCrontab());
  writeCrontab(`${base ? `${base}\n` : ''}${line}\n`);
  console.log(`Tarefa instalada:\n${line}`);
} else if (action === 'remove') {
  const base = without(readCrontab());
  writeCrontab(base ? `${base}\n` : '');
  console.log('Tarefa removida.');
} else {
  const found = readCrontab().split('\n').filter((l) => l.includes(MARK));
  console.log(found.length ? found.join('\n') : 'Nenhuma tarefa instalada.');
}
