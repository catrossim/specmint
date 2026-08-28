import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 读同目录 config.json 的 auth 段。文件不存在则返回空对象。 */
function loadAuth() {
  try {
    const raw = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf-8'));
    return raw.auth ?? {};
  } catch {
    return {};
  }
}

/** 展开字符串里的 ${ENV_VAR}。未设置时 warning + 空串（fail-fast 让 CI 知道是配置问题）。 */
function expandEnv(value, source) {
  if (typeof value !== 'string' || !value.includes('${')) return value;
  return value.replace(/\${([A-Z_][A-Z0-9_]*)}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined) console.warn('[playwright.config] ' + source + ' 中 $' + '{' + name + '} 未设置，使用空串');
    return v ?? '';
  });
}

/** 合并 config.auth.headers + extraHTTPHeaders + AUTO_TEST_HEADER_* env。 */
function buildHeaders() {
  const auth = loadAuth();
  const out = {};
  const headersFromConfig = { ...(auth.headers ?? {}), ...(auth.extraHTTPHeaders ?? {}) };
  for (const [k, v] of Object.entries(headersFromConfig)) {
    out[k] = expandEnv(v, 'auth.headers.' + k);
  }
  // CLI flag 通过 AUTO_TEST_HEADER_<KEY>=V 注入；key 转回 kebab-case（如 X_TENANT -> X-Tenant）
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('AUTO_TEST_HEADER_') && v !== undefined) {
      const headerName = k.slice('AUTO_TEST_HEADER_'.length).split('_').map((s, i) =>
        i === 0 ? s : s.charAt(0) + s.slice(1).toLowerCase()
      ).join('-');
      out[headerName] = v;
    }
  }
  return out;
}

function resolveStorageState() {
  if (process.env.AUTO_TEST_NO_AUTH === '1') return undefined;
  if (process.env.AUTO_TEST_STORAGE_STATE) return process.env.AUTO_TEST_STORAGE_STATE;
  const auth = loadAuth();
  return expandEnv(auth.storageState ?? '', 'auth.storageState') || undefined;
}

const headers = buildHeaders();
const storageState = resolveStorageState();

const use = {
  baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
  headless: true,
  ...(Object.keys(headers).length > 0 ? { extraHTTPHeaders: headers } : {}),
  ...(storageState ? { storageState } : {}),
};

export default defineConfig({
  projects: [
    {
      name: 'auth-setup',
      testMatch: /\.setup\.ts$/,
      testDir: './auth',
    },
    {
      name: 'e2e',
      testDir: './cases',
      dependencies: ['auth-setup'],
      use,
    },
  ],
  timeout: 30_000,
  /**
   * 批次产物落点（由 executor 注入；缺失时回退到项目根的 Playwright 默认）：
   * - AUTO_TEST_OUTPUT_DIR：screenshots / videos / traces 输出目录
   * - AUTO_TEST_JSON_OUTPUT_FILE：JSON reporter 输出文件
   *
   * executor 把它们指向 `.auto-test/reports/runs/<batchId>/artifacts` 和
   * `.auto-test/reports/runs/<batchId>/results.json`，实现"按批次号组织"。
   */
  outputDir: process.env.AUTO_TEST_OUTPUT_DIR ?? './test-results',
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.AUTO_TEST_JSON_OUTPUT_FILE ?? './reports/runs/.tmp/results.json' }],
  ],
});
