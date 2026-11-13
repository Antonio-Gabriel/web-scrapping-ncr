#!/usr/bin/env node
import { runSync } from '../sync.js';

const trigger = process.argv.includes('--cron') ? 'cron' : 'manual';
runSync({ trigger, live: process.argv.includes('--live') }).catch((e) => {
  console.error(`[${new Date().toISOString()}] ERRO: ${e.stack || e}`);
  process.exitCode = 1;
});
