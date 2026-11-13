#!/usr/bin/env node
// Uso: node src/cli/sync.js [--fonte=ncr|qr] [--cron] [--live]
import { SOURCES } from '../sources.js';
import { runSync } from '../sync.js';

const arg = process.argv.find((a) => a.startsWith('--fonte='));
const source = arg ? arg.split('=')[1] : 'ncr';
if (!SOURCES[source]) {
  console.error(`Fonte desconhecida: ${source}. Usa uma destas: ${Object.keys(SOURCES).join(', ')}`);
  process.exit(2);
}
const trigger = process.argv.includes('--cron') ? 'cron' : 'manual';
runSync({ source, trigger, live: process.argv.includes('--live') }).catch((e) => {
  console.error(`[${new Date().toISOString()}] ERRO: ${e.stack || e}`);
  process.exitCode = 1;
});
