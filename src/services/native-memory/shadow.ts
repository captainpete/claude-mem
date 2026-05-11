import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import { getNativeMemoryShadowDir } from '../spool/paths.js';

function shadowPath(project: string, filename: string): string {
  const safe = project.replace(/[^a-zA-Z0-9._/-]/g, '_');
  return join(getNativeMemoryShadowDir(), safe, filename);
}

export function readShadow(project: string, filename: string): string | null {
  const p = shadowPath(project, filename);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

export function writeShadow(project: string, filename: string, content: string): void {
  const p = shadowPath(project, filename);
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, p);
  } catch {
    /* best-effort */
  }
}

export function deleteShadow(project: string, filename: string): void {
  const p = shadowPath(project, filename);
  if (existsSync(p)) {
    try { rmSync(p); } catch { /* ignore */ }
  }
}
