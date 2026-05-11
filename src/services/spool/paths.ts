import path from 'path';
import { mkdirSync } from 'fs';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

function dataDir(): string {
  return SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
}

export function getSpoolDir(): string {
  const dir = path.join(dataDir(), 'spool');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getPendingDir(): string {
  const dir = path.join(getSpoolDir(), 'pending');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getNativeMemoryShadowDir(): string {
  const dir = path.join(dataDir(), 'native-memory-shadow');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getProjectCachePath(): string {
  return path.join(getSpoolDir(), 'project-cache.json');
}
