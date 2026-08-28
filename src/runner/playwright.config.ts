/**
 * 包内 Playwright 配置（specmint 工具内部资源）。
 *
 * 设计要点：
 * - 严格不用 `__dirname/..` 推断项目根 —— 包内配置位于 dist/runner/，往上两步是
 *   包根而非用户项目根，会让用例静默找不到
 * - 所有用户路径（cases/auth/config）由 executor 通过 SPECMINT_* env 注入；
 *   env 缺失时回退 `cwd` + STORAGE_LAYOUT（脱离 specmint run 直接跑也能用）
 * - auth-setup project 仅在检测到 *.setup.ts 时才挂载，根治"占位 setup 失败连坐"
 *   与"无 setup 时跑空"两个独立 bug
 * - runner 段默认 trace='retain-on-failure' / screenshot='only-on-failure' / timeoutMs=30000
 * - 直接 import 包内完整 reporter（onTestEnd + onEnd 收尾），消灭模板内联版漂移
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolveFile } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlaywrightTestConfig } from '@playwright/test';
import { STORAGE_LAYOUT, type AutoTestConfig } from '../config.js';

/** 包内 reporter 绝对路径，Playwright 加载自定义 reporter 需要绝对路径 */
const REPORTER_PATH = resolveFile(
  dirname(fileURLToPath(import.meta.url)),
  'reporter.js',
);

function loadConfig(): AutoTestConfig | null {
  const configPath =
    process.env.SPECMINT_CONFIG_PATH ??
    join(process.cwd(), STORAGE_LAYOUT.configFile);
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as AutoTestConfig;
  } catch {
    return null;
  }
}

function expandEnv(value: string, source: string): string {
  if (!value.includes('${')) return value;
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined || v === '') {
      console.warn(`[playwright.config] ${source} 中 \${${name}} 未设置，使用空串`);
    }
    return v ?? '';
  });
}

function buildHeaders(auth: AutoTestConfig['auth'] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const fromConfig = { ...(auth?.headers ?? {}), ...(auth?.extraHTTPHeaders ?? {}) };
  for (const [k, v] of Object.entries(fromConfig)) {
    out[k] = expandEnv(v, `auth.headers.${k}`);
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('SPECMINT_HEADER_') && v !== undefined) {
      const headerName = k.slice('SPECMINT_HEADER_'.length)
        .split('_')
        .map((s, i) => (i === 0 ? s : s.charAt(0) + s.slice(1).toLowerCase()))
        .join('-');
      out[headerName] = v;
    }
  }
  return out;
}

function resolveStorageState(auth: AutoTestConfig['auth'] | undefined): string | undefined {
  if (process.env.SPECMINT_NO_AUTH === '1') return undefined;
  if (process.env.SPECMINT_STORAGE_STATE) return process.env.SPECMINT_STORAGE_STATE;
  if (!auth?.storageState) return undefined;
  const expanded = expandEnv(auth.storageState, 'auth.storageState');
  return expanded || undefined;
}

function buildUse(auth: AutoTestConfig['auth'] | undefined): Record<string, unknown> {
  const headers = buildHeaders(auth);
  const storageState = resolveStorageState(auth);
  const channel = process.env.SPECMINT_BROWSER_CHANNEL;
  const cfg = loadConfig();
  return {
    baseURL: process.env.BASE_URL ?? process.env.SPECMINT_BASE_URL ?? 'http://localhost:3000',
    headless: true,
    trace: resolveTrace(cfg),
    screenshot: resolveScreenshot(cfg),
    ...(Object.keys(headers).length > 0 ? { extraHTTPHeaders: headers } : {}),
    ...(storageState ? { storageState } : {}),
    ...(channel ? { channel } : {}),
  };
}

function hasSetupFiles(): boolean {
  const authDir =
    process.env.SPECMINT_AUTH_DIR ?? join(process.cwd(), STORAGE_LAYOUT.authDir);
  if (!existsSync(authDir)) return false;
  try {
    return readdirSync(authDir).some((f) => f.endsWith('.setup.ts'));
  } catch {
    return false;
  }
}

function buildProjects(auth: AutoTestConfig['auth'] | undefined): Array<Record<string, unknown>> {
  const use = buildUse(auth);
  const casesDir =
    process.env.SPECMINT_CASES_DIR ?? join(process.cwd(), STORAGE_LAYOUT.cases);
  const authDir =
    process.env.SPECMINT_AUTH_DIR ?? join(process.cwd(), STORAGE_LAYOUT.authDir);
  const hasAuth = hasSetupFiles();
  const projects: Array<Record<string, unknown>> = [];
  if (hasAuth) {
    projects.push({
      name: 'auth-setup',
      testMatch: /\.setup\.ts$/,
      testDir: authDir,
      use,
    });
  }
  projects.push({
    name: 'chromium',
    testDir: casesDir,
    ...(hasAuth ? { dependencies: ['auth-setup'] } : {}),
    use,
  });
  return projects;
}

function resolveTrace(cfg: AutoTestConfig | null): 'on-first-retry' | 'retain-on-failure' | 'off' {
  const v = cfg?.runner?.trace ?? 'retain-on-failure';
  return v === 'on-first-retry' || v === 'retain-on-failure' || v === 'off'
    ? v
    : 'retain-on-failure';
}

function resolveScreenshot(cfg: AutoTestConfig | null): 'on' | 'off' | 'only-on-failure' {
  const v = cfg?.runner?.screenshot ?? 'only-on-failure';
  return v === 'on' || v === 'off' || v === 'only-on-failure' ? v : 'only-on-failure';
}

const cfg = loadConfig();

/**
 * 包内 Playwright 配置（用户运行 `specmint run` 时被 Playwright 加载）。
 *
 * 重要：使用 `import type` 而不是 `import { defineConfig } from '@playwright/test'`，
 * 并以 `satisfies PlaywrightTestConfig` 做类型校验。这能彻底避免本文件运行时
 * 触发对 `@playwright/test` 的 require——否则 Playwright 在加载本 config 时会从
 * specmint 自身的 node_modules 解析到一份 `@playwright/test` 实例，又会在随后
 * 加载用户 spec.ts 时从 cwd（用户项目）解析到另一份，从而触发
 * "Requiring @playwright/test second time" 错误。
 *
 * 历史修复：参见 hotst 项目报的 dual load 报错。运行时不再依赖 `@playwright/test`，
 * 类型完整性通过 `import type` + `satisfies` 同时保留。
 */
const config = {
  // `buildProjects` 返回 `Record<string, unknown>[]`，与 FullProject 字段 duck 兼容，
  // 但 TS 严格类型下不相容。这里做一次窄断言（仅 projects），其余字段由 satisfies
  // 校验（如 timeout / outputDir / reporter 等）。
  projects: buildProjects(cfg?.auth) as unknown as PlaywrightTestConfig['projects'],
  timeout: cfg?.runner?.timeoutMs ?? 30_000,
  outputDir:
    process.env.SPECMINT_OUTPUT_DIR ?? join(process.cwd(), 'test-results'),
  reporter: [
    ['list'],
    [
      'json',
      {
        outputFile:
          process.env.SPECMINT_JSON_OUTPUT_FILE ??
          join(process.cwd(), 'reports/runs/.tmp/results.json'),
      },
    ],
    [REPORTER_PATH],
  ],
} satisfies PlaywrightTestConfig;

export default config;