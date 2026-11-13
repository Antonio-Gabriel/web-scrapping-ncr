import fs from 'node:fs';
import { config } from './config.js';

function holderIsAlive(lockPath) {
  try {
    const pid = Number(fs.readFileSync(lockPath, 'utf8'));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: o processo existe, mas pertence a outro utilizador.
    return e.code === 'EPERM';
  }
}

export function acquireLock(lockPath = config.lockPath) {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (holderIsAlive(lockPath)) return false;
    fs.writeFileSync(lockPath, String(process.pid));
  }
  return true;
}

export const releaseLock = (lockPath = config.lockPath) => fs.rmSync(lockPath, { force: true });

export const syncIsRunning = (lockPath = config.lockPath) => fs.existsSync(lockPath) && holderIsAlive(lockPath);
