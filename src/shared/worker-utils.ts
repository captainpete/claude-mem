import path from "path";
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync, writeSync } from "fs";
import { execSync } from "child_process";
import { spawnHidden } from "./spawn.js";
import { logger } from "../utils/logger.js";
import { HOOK_TIMEOUTS, getTimeout } from "./hook-constants.js";
import { SettingsDefaultsManager } from "./SettingsDefaultsManager.js";
import { MARKETPLACE_ROOT, DATA_DIR } from "./paths.js";
import { loadFromFileOnce } from "./hook-settings.js";
import { validateWorkerPidFile } from "../supervisor/index.js";
import {
  enqueue as spoolEnqueue,
  drain as spoolDrain,
  pendingCount as spoolPendingCount,
  type Replayer as SpoolReplayer,
} from "../services/spool/index.js";

function readTimeoutEnv(
  envName: string,
  defaultValue: number,
  bounds: { min: number; max: number }
): number {
  const envVal = process.env[envName];
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed >= bounds.min && parsed <= bounds.max) {
      return parsed;
    }
    logger.warn('SYSTEM', `Invalid ${envName}, using default`, {
      value: envVal, min: bounds.min, max: bounds.max
    });
  }
  return defaultValue;
}

const HEALTH_CHECK_TIMEOUT_MS = readTimeoutEnv(
  'CLAUDE_MEM_HEALTH_TIMEOUT_MS',
  getTimeout(HOOK_TIMEOUTS.HEALTH_CHECK),
  { min: 500, max: 300000 }
);

const API_REQUEST_TIMEOUT_MS = readTimeoutEnv(
  'CLAUDE_MEM_API_TIMEOUT_MS',
  getTimeout(HOOK_TIMEOUTS.API_REQUEST),
  { min: 500, max: 300000 }
);

const HOOK_READINESS_TIMEOUT_MS = readTimeoutEnv(
  'CLAUDE_MEM_HOOK_READINESS_TIMEOUT_MS',
  getTimeout(HOOK_TIMEOUTS.HOOK_READINESS_WAIT),
  { min: 0, max: 300000 }
);

export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(
      () => reject(new Error(`Request timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    fetch(url, init).then(
      response => { clearTimeout(timeoutId); resolve(response); },
      err => { clearTimeout(timeoutId); reject(err); }
    );
  });
}

let cachedPort: number | null = null;
let cachedHost: string | null = null;
let cachedUrl: string | null = null;

export function getWorkerPort(): number {
  if (cachedPort !== null) {
    return cachedPort;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedPort = parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10);
  return cachedPort;
}

export function getWorkerHost(): string {
  if (cachedHost !== null) {
    return cachedHost;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedHost = settings.CLAUDE_MEM_WORKER_HOST;
  return cachedHost;
}

/**
 * Get the configured remote worker URL, if any.
 * Uses CLAUDE_MEM_WORKER_URL from settings file or default ('').
 * When non-empty, hooks connect to this URL and no local daemon is spawned.
 * Caches the value to avoid repeated file reads.
 */
export function getWorkerUrl(): string {
  if (cachedUrl !== null) {
    return cachedUrl;
  }

  const settingsPath = path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  cachedUrl = (settings.CLAUDE_MEM_WORKER_URL ?? '').trim();
  return cachedUrl;
}

/**
 * Returns true whenever CLAUDE_MEM_WORKER_URL is set to a non-empty value.
 * URL parseability is enforced by SettingsRoutes at save time; here we only
 * check whether the user has opted into remote mode at all. Loopback URLs
 * are valid (e.g. when forwarded by an SSH tunnel on the local machine).
 */
export function isRemoteWorker(): boolean {
  return getWorkerUrl().length > 0;
}

export function clearPortCache(): void {
  cachedPort = null;
  cachedHost = null;
  cachedUrl = null;
}

export function buildWorkerUrl(apiPath: string): string {
  if (isRemoteWorker()) {
    const base = getWorkerUrl().replace(/\/$/, '');
    return `${base}${apiPath}`;
  }
  return `http://${getWorkerHost()}:${getWorkerPort()}${apiPath}`;
}

/**
 * Base URL (no API path) for the worker HTTP server.
 * In remote mode, returns the configured CLAUDE_MEM_WORKER_URL (trailing slash stripped).
 * Otherwise http://{host}:{port}. Used by HealthMonitor functions that take a baseUrl.
 */
export function getWorkerBaseUrl(): string {
  if (isRemoteWorker()) {
    return getWorkerUrl().replace(/\/$/, '');
  }
  return `http://${getWorkerHost()}:${getWorkerPort()}`;
}

export function workerHttpRequest(
  apiPath: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {}
): Promise<Response> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? API_REQUEST_TIMEOUT_MS;

  const url = buildWorkerUrl(apiPath);
  const init: RequestInit = { method };
  if (options.headers) {
    init.headers = options.headers;
  }
  if (options.body) {
    init.body = options.body;
  }

  if (timeoutMs > 0) {
    return fetchWithTimeout(url, init, timeoutMs);
  }
  return fetch(url, init);
}

async function isWorkerHealthy(): Promise<boolean> {
  const response = await workerHttpRequest('/api/health', { timeoutMs: HEALTH_CHECK_TIMEOUT_MS });
  return response.ok;
}

async function isWorkerReady(): Promise<boolean> {
  const response = await workerHttpRequest('/api/readiness', { timeoutMs: HEALTH_CHECK_TIMEOUT_MS });
  return response.ok;
}

function getPluginVersion(): string {
  try {
    const packageJsonPath = path.join(MARKETPLACE_ROOT, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch (error: unknown) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || code === 'EBUSY') {
      logger.debug('SYSTEM', 'Could not read plugin version (shutdown race)', { code });
      return 'unknown';
    }
    throw error;
  }
}

async function getWorkerVersion(): Promise<string> {
  const response = await workerHttpRequest('/api/version', { timeoutMs: HEALTH_CHECK_TIMEOUT_MS });
  if (!response.ok) {
    throw new Error(`Failed to get worker version: ${response.status}`);
  }
  const data = await response.json() as { version: string };
  return data.version;
}

async function checkWorkerVersion(): Promise<void> {
  // Remote worker mode: the client's plugin version may legitimately differ
  // from the remote worker's version. Skip the comparison entirely.
  if (isRemoteWorker()) return;

  let pluginVersion: string;
  try {
    pluginVersion = getPluginVersion();
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Version check failed reading plugin version', {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  if (pluginVersion === 'unknown') return;

  let workerVersion: string;
  try {
    workerVersion = await getWorkerVersion();
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Version check failed reading worker version', {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  if (workerVersion === 'unknown') return;

  if (pluginVersion !== workerVersion) {
    logger.debug('SYSTEM', 'Version check', {
      pluginVersion,
      workerVersion,
      note: 'Mismatch will be auto-restarted by worker-service start command'
    });
  }
}

function resolveWorkerScriptPath(): string | null {
  const candidates = [
    path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'worker-service.cjs'),
    path.join(process.cwd(), 'plugin', 'scripts', 'worker-service.cjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveBunRuntime(): string | null {
  if (process.env.BUN && existsSync(process.env.BUN)) return process.env.BUN;

  try {
    const cmd = process.platform === 'win32' ? 'where bun' : 'which bun';
    const output = execSync(cmd, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      windowsHide: true,
    });
    const firstMatch = output
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line.length > 0);
    return firstMatch || null;
  } catch {
    return null;
  }
}

async function waitForWorkerPort(options: { attempts: number; backoffMs: number }): Promise<boolean> {
  let delayMs = options.backoffMs;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    if (await isWorkerPortAlive()) return true;
    if (attempt < options.attempts) {
      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
  return false;
}

async function waitForWorkerReadiness(timeoutMs: number = HOOK_READINESS_TIMEOUT_MS): Promise<boolean> {
  if (timeoutMs <= 0) {
    try {
      return await isWorkerReady();
    } catch {
      return false;
    }
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await isWorkerReady()) return true;
    } catch (error: unknown) {
      logger.debug('SYSTEM', 'Worker readiness check threw', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const remainingMs = timeoutMs - (Date.now() - start);
    if (remainingMs <= 0) break;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(250, remainingMs)));
  }
  return false;
}

async function isWorkerPortAlive(): Promise<boolean> {
  let healthy: boolean;
  try {
    healthy = await isWorkerHealthy();
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Worker health check threw', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  if (!healthy) return false;

  const pidStatus = validateWorkerPidFile({ logAlive: false });
  if (pidStatus === 'missing') return true;     
  if (pidStatus === 'alive') return true;       
  return false;                                 
}

export async function ensureWorkerRunning(): Promise<boolean> {
  if (await isWorkerPortAlive()) {
    await checkWorkerVersion();
    const ready = await waitForWorkerReadiness();
    if (!ready) {
      logger.warn('SYSTEM', 'Worker is healthy but not ready; skipping hook API call');
      return false;
    }
    return true;
  }

  const runtimePath = resolveBunRuntime();
  const scriptPath = resolveWorkerScriptPath();

  if (!runtimePath) {
    logger.warn('SYSTEM', 'Cannot lazy-spawn worker: Bun runtime not found on PATH');
    return false;
  }
  if (!scriptPath) {
    logger.warn('SYSTEM', 'Cannot lazy-spawn worker: worker-service.cjs not found in plugin/scripts');
    return false;
  }

  logger.info('SYSTEM', 'Worker not running — lazy-spawning', { runtimePath, scriptPath });

  try {
    const proc = spawnHidden(runtimePath, [scriptPath, '--daemon'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.unref();
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.error('SYSTEM', 'Lazy-spawn of worker failed', { runtimePath, scriptPath }, error);
    } else {
      logger.error('SYSTEM', 'Lazy-spawn of worker failed (non-Error)', {
        runtimePath, scriptPath, error: String(error),
      });
    }
    return false;
  }

  const alive = await waitForWorkerPort({ attempts: 3, backoffMs: 250 });
  if (!alive) {
    logger.warn('SYSTEM', 'Worker port did not open after lazy-spawn within 3 attempts');
    return false;
  }
  const ready = await waitForWorkerReadiness();
  if (!ready) {
    logger.warn('SYSTEM', 'Worker lazy-spawned but did not become ready before hook readiness timeout');
    return false;
  }
  return true;
}

let aliveCache: boolean | null = null;

export async function ensureWorkerAliveOnce(): Promise<boolean> {
  if (aliveCache !== null) return aliveCache;
  aliveCache = await ensureWorkerRunning();
  return aliveCache;
}

interface HookFailureState {
  consecutiveFailures: number;
  lastFailureAt: number;
}

const FAIL_LOUD_DEFAULT_THRESHOLD = 3;

function getStateDir(): string {
  return path.join(DATA_DIR, 'state');
}

function getHookFailuresPath(): string {
  return path.join(getStateDir(), 'hook-failures.json');
}

function readHookFailureState(): HookFailureState {
  try {
    const raw = readFileSync(getHookFailuresPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<HookFailureState>;
    return {
      consecutiveFailures: typeof parsed.consecutiveFailures === 'number' && Number.isFinite(parsed.consecutiveFailures)
        ? Math.max(0, Math.floor(parsed.consecutiveFailures))
        : 0,
      lastFailureAt: typeof parsed.lastFailureAt === 'number' && Number.isFinite(parsed.lastFailureAt)
        ? parsed.lastFailureAt
        : 0,
    };
  } catch {
    return { consecutiveFailures: 0, lastFailureAt: 0 };
  }
}

function writeHookFailureStateAtomic(state: HookFailureState): void {
  const stateDir = getStateDir();
  const dest = getHookFailuresPath();
  const tmp = `${dest}.tmp`;
  try {
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }
    writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    renameSync(tmp, dest);
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Failed to persist hook-failure counter', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function getFailLoudThreshold(): number {
  try {
    const settings = loadFromFileOnce();
    const raw = settings.CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD;
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  } catch {
    // settings unreadable — fall through to default
  }
  return FAIL_LOUD_DEFAULT_THRESHOLD;
}

function recordWorkerUnreachable(): number {
  const state = readHookFailureState();
  const next: HookFailureState = {
    consecutiveFailures: state.consecutiveFailures + 1,
    lastFailureAt: Date.now(),
  };
  writeHookFailureStateAtomic(next);

  const threshold = getFailLoudThreshold();
  if (next.consecutiveFailures >= threshold) {
    // writeSync(2, ...) goes straight to fd 2, bypassing hookCommand's
    // process.stderr.write override that would otherwise swallow the warning.
    // Do not process.exit — honors the exit-0 philosophy spelled out in CLAUDE.md
    // ("Worker/hook errors exit with code 0 to prevent Windows Terminal tab
    // accumulation") so hooks continue gracefully instead of blocking tool calls.
    try {
      writeSync(2, `claude-mem worker unreachable for ${next.consecutiveFailures} consecutive hooks.\n`);
    } catch {
      // stderr unwritable — nothing actionable
    }
  }
  return next.consecutiveFailures;
}

function resetWorkerFailureCounter(): void {
  const state = readHookFailureState();
  if (state.consecutiveFailures === 0) return;       
  writeHookFailureStateAtomic({ consecutiveFailures: 0, lastFailureAt: 0 });
}

const WORKER_FALLBACK_BRAND: unique symbol = Symbol.for('claude-mem/worker-fallback');

export type WorkerFallback =
  | { continue: true; [WORKER_FALLBACK_BRAND]: true }
  | { continue: true; reason: string; [WORKER_FALLBACK_BRAND]: true };

export type WorkerCallResult<T> = T | WorkerFallback;

export function isWorkerFallback<T>(result: WorkerCallResult<T>): result is WorkerFallback {
  return typeof result === 'object'
    && result !== null
    && (result as { [WORKER_FALLBACK_BRAND]?: unknown })[WORKER_FALLBACK_BRAND] === true;
}

export interface WorkerFallbackOptions {
  timeoutMs?: number;
}

function spoolWriteOnFallback(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body: unknown,
): void {
  if (body === undefined) return;
  if (method === 'GET') return;
  spoolEnqueue({ url, method, body });
}

export async function executeWithWorkerFallback<T = unknown>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
  options: WorkerFallbackOptions = {},
): Promise<WorkerCallResult<T>> {
  const alive = await ensureWorkerAliveOnce();
  if (!alive) {
    // Spool before bookkeeping so observations queue even if a future change
    // to recordWorkerUnreachable reintroduces an early process.exit.
    spoolWriteOnFallback(url, method, body);
    recordWorkerUnreachable();
    return { continue: true, reason: 'worker_unreachable', [WORKER_FALLBACK_BRAND]: true };
  }

  const init: { method: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  if (options.timeoutMs !== undefined) {
    init.timeoutMs = options.timeoutMs;
  }

  const response = await workerHttpRequest(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    resetWorkerFailureCounter();
    if (response.status === 429 || response.status >= 500) {
      logger.warn('SYSTEM', `Worker API ${method} ${url} returned ${response.status}; skipping hook API call`, {
        body: text.substring(0, 200),
      });
      spoolWriteOnFallback(url, method, body);
      return {
        continue: true,
        reason: `worker_api_${response.status}`,
        [WORKER_FALLBACK_BRAND]: true,
      };
    }

    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep raw text */ }
    return parsed as T;
  }

  resetWorkerFailureCounter();
  const text = await response.text();
  if (text.length === 0) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export async function drainSpool(timeoutMs: number = 5000): Promise<{ drained: number; remaining: number }> {
  if (spoolPendingCount() === 0) return { drained: 0, remaining: 0 };

  const replayer: SpoolReplayer = async (req) => {
    const init: { method: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {
      method: req.method,
      timeoutMs: API_REQUEST_TIMEOUT_MS,
    };
    if (req.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(req.body);
    }
    try {
      const response = await workerHttpRequest(req.url, init);
      return { ok: response.ok };
    } catch {
      return { ok: false };
    }
  };

  const result = await spoolDrain(replayer, { timeoutMs });
  return { drained: result.drained, remaining: result.remaining };
}

export function enqueueImport(payload: { sessions: unknown[]; observations: unknown[] }): void {
  spoolEnqueue({ url: '/api/import', method: 'POST', body: payload });
}
