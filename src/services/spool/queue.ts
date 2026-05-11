import path from 'path';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
  existsSync,
} from 'fs';
import { randomBytes } from 'crypto';
import { logger } from '../../utils/logger.js';
import { getPendingDir } from './paths.js';
import type { SpooledRequest, DrainResult } from './types.js';

const FILENAME_RE = /^\d{13}-[0-9a-f]{8}\.json$/;

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, filePath);
}

function makeFilename(): string {
  return `${Date.now().toString().padStart(13, '0')}-${randomBytes(4).toString('hex')}.json`;
}

export function enqueue(req: Omit<SpooledRequest, 'enqueuedAt'>): void {
  const full: SpooledRequest = { ...req, enqueuedAt: Date.now() };
  const dest = path.join(getPendingDir(), makeFilename());
  try {
    atomicWrite(dest, JSON.stringify(full));
  } catch (error: unknown) {
    logger.warn('SYSTEM', 'spool enqueue failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function pendingCount(): number {
  try {
    return readdirSync(getPendingDir()).filter(f => FILENAME_RE.test(f)).length;
  } catch {
    return 0;
  }
}

export type Replayer = (req: SpooledRequest) => Promise<{ ok: boolean }>;

export async function drain(
  replay: Replayer,
  options: { timeoutMs: number; maxBatch?: number } = { timeoutMs: 5000 }
): Promise<DrainResult> {
  const dir = getPendingDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => FILENAME_RE.test(f)).sort();
  } catch {
    return { attempted: 0, drained: 0, remaining: 0 };
  }

  const start = Date.now();
  const maxBatch = options.maxBatch ?? 100;
  let attempted = 0;
  let drained = 0;

  for (const f of files) {
    if (attempted >= maxBatch) break;
    if (Date.now() - start >= options.timeoutMs) break;

    const fp = path.join(dir, f);
    if (!existsSync(fp)) continue;

    let req: SpooledRequest;
    try {
      req = JSON.parse(readFileSync(fp, 'utf-8'));
    } catch {
      try { unlinkSync(fp); } catch { /* ignore */ }
      continue;
    }

    attempted++;
    let ok = false;
    try {
      const result = await replay(req);
      ok = result.ok;
    } catch {
      ok = false;
    }

    if (ok) {
      try { unlinkSync(fp); drained++; } catch { /* ignore */ }
    } else {
      break;
    }
  }

  return { attempted, drained, remaining: Math.max(0, files.length - drained) };
}
