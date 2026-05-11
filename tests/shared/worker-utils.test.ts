/**
 * worker-utils Tests
 *
 * Tests for the remote worker URL helpers: isRemoteWorker(), getWorkerUrl(),
 * buildWorkerUrl(). Uses a temp CLAUDE_MEM_DATA_DIR per test so that each case
 * gets its own settings.json and the module-level cache can be cleared between
 * invocations via clearPortCache().
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildWorkerUrl,
  clearPortCache,
  getWorkerBaseUrl,
  getWorkerUrl,
  isRemoteWorker,
} from '../../src/shared/worker-utils.js';

describe('worker-utils remote mode', () => {
  let tempDir: string;
  let settingsPath: string;
  // SettingsDefaultsManager.applyEnvOverrides() clobbers file-level values
  // with whatever is in process.env. Other tests in the full suite may set
  // (or even empty-string) these keys and never clean up, which silently
  // makes remote-mode assertions fail. Snapshot and restore around each test.
  const POLLUTED_ENV_KEYS = [
    'CLAUDE_MEM_DATA_DIR',
    'CLAUDE_MEM_WORKER_URL',
    'CLAUDE_MEM_WORKER_HOST',
    'CLAUDE_MEM_WORKER_PORT',
  ] as const;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of POLLUTED_ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    tempDir = join(tmpdir(), `worker-utils-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
    process.env.CLAUDE_MEM_DATA_DIR = tempDir;
    clearPortCache();
  });

  afterEach(() => {
    clearPortCache();
    for (const key of POLLUTED_ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function writeSettings(overrides: Record<string, string>) {
    const base = {
      CLAUDE_MEM_WORKER_PORT: '37777',
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_WORKER_URL: '',
      CLAUDE_MEM_DATA_DIR: tempDir,
      ...overrides,
    };
    writeFileSync(settingsPath, JSON.stringify(base, null, 2), 'utf-8');
  }

  describe('isRemoteWorker', () => {
    it('returns false when CLAUDE_MEM_WORKER_URL is empty (local mode)', () => {
      writeSettings({ CLAUDE_MEM_WORKER_URL: '' });
      expect(isRemoteWorker()).toBe(false);
    });

    it('returns true for a remote hostname URL', () => {
      writeSettings({ CLAUDE_MEM_WORKER_URL: 'http://claude-mem.local:37777' });
      expect(isRemoteWorker()).toBe(true);
    });

    it('returns true for a remote IP URL', () => {
      writeSettings({ CLAUDE_MEM_WORKER_URL: 'http://192.168.1.10:37777' });
      expect(isRemoteWorker()).toBe(true);
    });

    it('returns true for loopback 127.0.0.1 (valid when behind a tunnel)', () => {
      writeSettings({ CLAUDE_MEM_WORKER_URL: 'http://127.0.0.1:37777' });
      expect(isRemoteWorker()).toBe(true);
    });

    it('returns true for localhost hostname (valid when behind a tunnel)', () => {
      writeSettings({ CLAUDE_MEM_WORKER_URL: 'http://localhost:37777' });
      expect(isRemoteWorker()).toBe(true);
    });

    it('returns true for any non-empty value (URL syntax enforced at save time)', () => {
      writeSettings({ CLAUDE_MEM_WORKER_URL: 'not a url at all' });
      expect(isRemoteWorker()).toBe(true);
    });

    it('trims surrounding whitespace before evaluating', () => {
      writeSettings({ CLAUDE_MEM_WORKER_URL: '  http://claude-mem.local:37777  ' });
      expect(getWorkerUrl()).toBe('http://claude-mem.local:37777');
      expect(isRemoteWorker()).toBe(true);
    });
  });

  describe('buildWorkerUrl', () => {
    it('uses host+port in local mode', () => {
      writeSettings({
        CLAUDE_MEM_WORKER_URL: '',
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
        CLAUDE_MEM_WORKER_PORT: '37777',
      });
      expect(buildWorkerUrl('/api/health')).toBe('http://127.0.0.1:37777/api/health');
    });

    it('uses the configured remote URL as base in remote mode', () => {
      writeSettings({ CLAUDE_MEM_WORKER_URL: 'http://claude-mem.local:37777' });
      expect(buildWorkerUrl('/api/health')).toBe('http://claude-mem.local:37777/api/health');
    });

    it('strips a trailing slash on the configured URL', () => {
      writeSettings({ CLAUDE_MEM_WORKER_URL: 'http://claude-mem.local:37777/' });
      expect(buildWorkerUrl('/api/health')).toBe('http://claude-mem.local:37777/api/health');
    });

    it('ignores host+port in remote mode', () => {
      // Remote URL must win even if HOST/PORT are still set to something else —
      // otherwise a user who points at a remote and forgets to clear HOST gets
      // silently mixed requests.
      writeSettings({
        CLAUDE_MEM_WORKER_URL: 'http://claude-mem.local:8080',
        CLAUDE_MEM_WORKER_HOST: '10.0.0.5',
        CLAUDE_MEM_WORKER_PORT: '99999',
      });
      expect(buildWorkerUrl('/api/search')).toBe('http://claude-mem.local:8080/api/search');
    });
  });

  describe('getWorkerBaseUrl', () => {
    it('returns http://host:port in local mode', () => {
      writeSettings({
        CLAUDE_MEM_WORKER_URL: '',
        CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
        CLAUDE_MEM_WORKER_PORT: '37777',
      });
      expect(getWorkerBaseUrl()).toBe('http://127.0.0.1:37777');
    });

    it('returns the remote URL (stripped of trailing slash) in remote mode', () => {
      writeSettings({ CLAUDE_MEM_WORKER_URL: 'http://claude-mem.local:37777/' });
      expect(getWorkerBaseUrl()).toBe('http://claude-mem.local:37777');
    });
  });
});
