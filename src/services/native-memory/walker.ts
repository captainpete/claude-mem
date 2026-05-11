import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { decodeNativeDirName, resolveProject } from './decoder.js';

export interface MemoryFile {
  memoryDir: string;
  file: string;
  filename: string;
  project: string;
  encodedDir: string;
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

export function getProjectsRoot(): string {
  return join(claudeConfigDir(), 'projects');
}

export function* listMemoryFiles(): Generator<MemoryFile> {
  const root = getProjectsRoot();
  if (!existsSync(root)) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const dir of entries) {
    const memDir = join(root, dir, 'memory');
    if (!existsSync(memDir)) continue;
    const decoded = decodeNativeDirName(dir);
    const project = resolveProject(decoded, dir);
    let files: string[];
    try {
      files = readdirSync(memDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      yield {
        memoryDir: memDir,
        file: join(memDir, f),
        filename: f,
        project,
        encodedDir: dir,
      };
    }
  }
}
