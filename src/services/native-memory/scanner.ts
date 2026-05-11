import { readFileSync, statSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { listMemoryFiles } from './walker.js';
import { flushProjectCache } from './decoder.js';
import { readShadow, writeShadow } from './shadow.js';
import {
  chunkMarkdown,
  chunkHash,
  buildSession,
  buildObservation,
} from './chunker.js';

export interface ImportPayload {
  sessions: unknown[];
  observations: unknown[];
}

export type ImportEnqueuer = (payload: ImportPayload) => void;

export interface ScanResult {
  filesScanned: number;
  filesChanged: number;
  chunksQueued: number;
}

export interface ScanOptions {
  timeoutMs?: number;
  maxFiles?: number;
}

export async function scanAndQueue(
  enqueue: ImportEnqueuer,
  options: ScanOptions = {}
): Promise<ScanResult> {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;

  let filesScanned = 0;
  let filesChanged = 0;
  let chunksQueued = 0;

  for (const { file, filename, project } of listMemoryFiles()) {
    if (filesScanned >= maxFiles) break;
    if (Date.now() - start >= timeoutMs) {
      logger.debug('SYSTEM', 'native-memory scan budget reached', { filesScanned });
      break;
    }
    filesScanned++;

    let content: string;
    let mtime: number;
    try {
      content = readFileSync(file, 'utf-8');
      mtime = Math.floor(statSync(file).mtimeMs / 1000);
    } catch {
      continue;
    }

    const shadow = readShadow(project, filename) ?? '';
    if (shadow === content) continue;

    const newChunks = chunkMarkdown(content);
    if (newChunks.length === 0) {
      writeShadow(project, filename, content);
      continue;
    }

    const oldHashes = new Set(chunkMarkdown(shadow).map(c => chunkHash(c.body)));
    const added = newChunks.filter(c => !oldHashes.has(chunkHash(c.body)));

    if (added.length === 0) {
      writeShadow(project, filename, content);
      continue;
    }

    const ctx = { project, filename, file, mtime };
    enqueue({
      sessions: [buildSession(ctx)],
      observations: added.map((c, idx) => buildObservation(ctx, c, idx)),
    });
    writeShadow(project, filename, content);
    filesChanged++;
    chunksQueued += added.length;
  }

  flushProjectCache();

  return { filesScanned, filesChanged, chunksQueued };
}
