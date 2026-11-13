import fs from 'node:fs';
import { config } from './config.js';

function holderIsAlive() {
  try {
    const pid = Number(fs.readFileSync(config.lockPath, 'utf8'));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: o processo existe, mas pertence a outro utilizador.
    return e.code === 'EPERM';
  }
}

export function acquireLock() {
  try {
    fs.writeFileSync(config.lockPath, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (holderIsAlive()) return false;
    fs.writeFileSync(config.lockPath, String(process.pid));
  }
  return true;
}

export const releaseLock = () => fs.rmSync(config.lockPath, { force: true });

export const syncIsRunning = () => fs.existsSync(config.lockPath) && holderIsAlive();
