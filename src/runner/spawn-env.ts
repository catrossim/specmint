/**
 * 子进程 env 协议统一收口。
 *
 * run / rerun / auth refresh 三入口共用此函数，避免各自实现漂移。
 * 包内 Playwright 配置（dist/runner/playwright.config.js）通过 SPECMINT_* env 读取
 * 用户路径与鉴权；BASE_URL 通过 buildSpawnEnv 显式透传（修 P0-1）。
 */
import { resolve as resolveFile } from 'node:path';
import type { AutoTestConfig } from '../config.js';
import { resolveBrowserChannel } from './browser-channel.js';

export interface SpawnAuthOptions {
  headers?: string[];
  storageState?: string;
  noAuth?: boolean;
}

export interface SpawnEnvOptions {
  cwd: string;
  casesDir: string;
  reportsDir: string;
  authDir: string;
  configPath: string;
  runId: string;
  outputDir: string;
  jsonOutputFile: string;
  auth?: SpawnAuthOptions;
  config: AutoTestConfig;
}

export interface BuiltSpawnEnv {
  env: Record<string, string | undefined>;
  fellBackToSystemBrowser: boolean;
}

function headerKeyToEnv(key: string): string {
  return `SPECMINT_HEADER_${key.replace(/-/g, '_').toUpperCase()}`;
}

/**
 * 展开 `${ENV_VAR}` 占位符（与 playwright.config.ts 中的 expandEnv 行为一致）。
 * 未设置的环境变量保留为空串（warn）；空输入返回 undefined。
 */
function expandEnv(value: string | undefined, source: string): string | undefined {
  if (!value) return undefined;
  if (!value.includes('${')) return value;
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined || v === '') {
      // eslint-disable-next-line no-console
      console.warn(`[spawn-env] ${source} 中 \${${name}} 未设置，使用空串`);
    }
    return v ?? '';
  });
}

export function buildSpawnEnv(opts: SpawnEnvOptions): BuiltSpawnEnv {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SPECMINT_CASES_DIR: resolveFile(opts.casesDir),
    SPECMINT_AUTH_DIR: resolveFile(opts.authDir),
    SPECMINT_CONFIG_PATH: resolveFile(opts.configPath),
    SPECMINT_REPORTS_DIR: resolveFile(opts.reportsDir),
    SPECMINT_RUN_ID: opts.runId,
    SPECMINT_OUTPUT_DIR: resolveFile(opts.outputDir),
    SPECMINT_JSON_OUTPUT_FILE: resolveFile(opts.jsonOutputFile),
    // 优先级：env (BASE_URL / SPECMINT_BASE_URL) > config.runner.baseURL > 默认
    BASE_URL:
      process.env.BASE_URL ??
      process.env.SPECMINT_BASE_URL ??
      expandEnv(opts.config.runner?.baseURL, 'runner.baseURL') ??
      'http://localhost:3000',
  };

  if (opts.auth?.noAuth) {
    env.SPECMINT_NO_AUTH = '1';
  } else if (opts.auth?.storageState) {
    env.SPECMINT_STORAGE_STATE = resolveFile(opts.auth.storageState);
  }

  if (opts.auth?.headers) {
    for (const h of opts.auth.headers) {
      const idx = h.indexOf(':');
      if (idx <= 0) continue;
      const key = h.slice(0, idx).trim();
      const value = h.slice(idx + 1).trim();
      if (key) env[headerKeyToEnv(key)] = value;
    }
  }

  const { channel, fellBack } = resolveBrowserChannel(opts.config.runner.browserChannel);
  if (channel) env.SPECMINT_BROWSER_CHANNEL = channel;

  return { env, fellBackToSystemBrowser: fellBack };
}