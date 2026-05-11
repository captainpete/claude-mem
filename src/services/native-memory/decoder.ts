import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { basename, dirname } from 'path';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import { getProjectCachePath } from '../spool/paths.js';

export function decodeNativeDirName(encoded: string): string | null {
  if (!encoded.startsWith('-')) return null;
  const tail = encoded.slice(1);

  const naive = '/' + tail.replace(/-/g, '/');
  if (existsSync(naive)) return naive;

  const segs = tail.split('-');
  let path = '';
  for (let i = 0; i < segs.length; i++) {
    let candidate = path + '/' + segs.slice(i, i + 1).join('-');
    while (i + 1 < segs.length) {
      const tryMerge = candidate + '-' + segs[i + 1];
      if (existsSync(tryMerge) && !existsSync(candidate)) {
        candidate = tryMerge;
        i++;
      } else if (existsSync(candidate)) {
        break;
      } else {
        candidate = tryMerge;
        i++;
      }
    }
    path = candidate;
  }
  return path || naive;
}

type ProjectCache = Record<string, string>;

let memCache: ProjectCache | null = null;
let memCacheDirty = false;

function loadCache(): ProjectCache {
  if (memCache !== null) return memCache;
  try {
    memCache = JSON.parse(readFileSync(getProjectCachePath(), 'utf-8')) as ProjectCache;
  } catch {
    memCache = {};
  }
  return memCache;
}

function persistCache(): void {
  if (!memCacheDirty || memCache === null) return;
  const dest = getProjectCachePath();
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(tmp, JSON.stringify(memCache), 'utf-8');
    renameSync(tmp, dest);
    memCacheDirty = false;
  } catch {
    /* best-effort */
  }
}

export function resolveProject(decodedCwd: string | null, encodedDir: string): string {
  const cache = loadCache();
  if (encodedDir in cache) return cache[encodedDir];

  let name: string;
  if (decodedCwd) {
    try {
      const toplevel = execSync(`git -C "${decodedCwd}" rev-parse --show-toplevel`, {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf-8',
      }).trim();
      name = basename(toplevel);
    } catch {
      name = basename(decodedCwd) || encodedDir;
    }
  } else {
    name = encodedDir;
  }

  cache[encodedDir] = name;
  memCacheDirty = true;
  return name;
}

export function flushProjectCache(): void {
  persistCache();
}
