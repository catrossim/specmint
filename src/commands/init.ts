/**
 * init 子命令：在当前目录初始化 auto-test 项目
 *
 * 职责：
 * 1. 创建 .auto-test/ 目录结构（cases、cases/pages、reports、reports/runs）
 * 2. 渲染 .auto-test/config.json（不可写到项目根，避免污染）
 * 3. 渲染 .auto-test/playwright.config.ts（同上）
 * 4. 追加 .gitignore 条目（幂等）
 * 5. 打印下一步建议
 *
 * 任务 1+ 改造要点：
 * - 强制 .auto-test/ 隐藏目录 + 强制两个配置文件都在 .auto-test/ 下
 * - 项目根零污染——不创建 tests/、src/、auto-test.config.json、playwright.config.ts
 * - storage / runner.configPath 不再支持配置（直接忽略老字段）
 *
 * 不做 npm install / npx playwright install —— 这些需要外部副作用，
 * 由用户自行执行，避免 init 子命令网络/系统依赖。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { STORAGE_LAYOUT } from '../config.js';
import { CliError, ExitCode } from '../utils/errors.js';

/**
 * .auto-test 内部目录树（init 时一并创建）
 */
const DEFAULT_DIRECTORIES = [
  '.auto-test',
  '.auto-test/cases',
  '.auto-test/cases/pages',
  '.auto-test/reports',
  '.auto-test/reports/runs',
  '.auto-test/auth',
  '.auto-test/auth/storage',
];

/**
 * 默认 .auto-test/config.json 内容
 *
 * 注意：
 * - 不写 storage 段（路径不可配置）
 * - 不写 runner.configPath（强制 .auto-test/playwright.config.ts）
 * - 用户可在这里改 model / defaultBrowser / agent 等其他字段
 */
const DEFAULT_CONFIG_OBJECT = {
  version: '1',
  agent: {
    // model 不写默认值——由 `auto-test models select` 选定
    delegate: 'sdk' as const,
    systemPromptAdditions: '',
  },
  explore: {
    enabledByDefault: false,
    headless: true,
    timeoutMs: 15000,
    maxElements: 200,
    waitUntil: 'domcontentloaded' as const,
  },
  generation: {
    selectorPolicy: {
      prefer: ['getByRole', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'getByText'],
      avoid: ['nth-child', 'nth-of-type', 'complex-css', 'xpath'],
    },
    language: 'zh',
    comments: 'verbose' as const,
    style: 'page-object-optional' as const,
  },
  runner: {
    defaultBrowser: 'chromium',
    trace: 'on-first-retry' as const,
    screenshot: 'only-on-failure' as const,
  },
};

const GITIGNORE_ADDITIONS = [
  '.auto-test/reports/runs/*/.tmp/',
  '.auto-test/.env',
];

/**
 * .auto-test/playwright.config.ts 模板
 *
 * 注意 testDir 用相对 __dirname 的形式（该文件位于 .auto-test/ 下），
 * 写 './cases' 即可；reporter 输出也用相对路径。
 *
 * 关于 auth：
 * - 读取同目录的 config.json 的 auth 段（headers / extraHTTPHeaders / cookies / storageState）
 * - 字段值里的 ${ENV_VAR} 自动展开（CI 注入）
 * - 进程环境变量 AUTO_TEST_HEADER_<KEY>=V 会覆盖对应 header（auto-test run --header 透传）
 * - AUTO_TEST_STORAGE_STATE=<path> 覆盖 storageState
 * - AUTO_TEST_NO_AUTH=1 跳过 storageState（公开页测试）
 *
 * 关于 projects：
 * - 默认拆 auth-setup + e2e 两个 project；auth-setup 在没有 *.setup.ts 时是空 project，被跳过
 * - 用户写 .auto-test/auth/*.setup.ts 即自动生效（无需再改本 config）
 */
const PLAYWRIGHT_CONFIG_BODY = `import { defineConfig } from '@playwright/test';
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

/** 展开字符串里的 \${ENV_VAR}。未设置时 warning + 空串（fail-fast 让 CI 知道是配置问题）。 */
function expandEnv(value, source) {
  if (typeof value !== 'string' || !value.includes('\${')) return value;
  return value.replace(/\\\${([A-Z_][A-Z0-9_]*)}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined) console.warn('[playwright.config] ' + source + ' 中 \$' + '{' + name + '} 未设置，使用空串');
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
      testMatch: /\\.setup\\.ts\$/,
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
  reporter: [
    ['list'],
    ['json', { outputFile: './reports/runs/.tmp/results.json' }],
  ],
});
`;

export interface InitOptions {
  force?: boolean;
  json?: boolean;
}

export interface InitResult {
  ok: true;
  cwd: string;
  root: string;
  configPath: string;
  runnerConfigPath: string;
  createdDirs: string[];
  wroteConfig: boolean;
  wrotePlaywrightConfig: boolean;
  updatedGitignore: boolean;
  nextSteps: string[];
}

/**
 * 创建目录（已存在则跳过）
 */
function ensureDirs(cwd: string, dirs: string[]): string[] {
  const created: string[] = [];
  for (const dir of dirs) {
    const fullPath = join(cwd, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
      created.push(dir);
    }
  }
  return created;
}

/**
 * 写入 .auto-test/config.json（已存在且无 --force 则跳过）
 */
function ensureConfig(cwd: string, force: boolean): boolean {
  const configPath = join(cwd, STORAGE_LAYOUT.configFile);
  if (existsSync(configPath) && !force) return false;
  ensureDir(dirname(configPath));
  writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG_OBJECT, null, 2) + '\n', 'utf-8');
  return true;
}

/**
 * 渲染 .auto-test/playwright.config.ts（已存在且无 --force 则跳过）
 */
function ensurePlaywrightConfig(cwd: string, force: boolean): boolean {
  const configPath = join(cwd, STORAGE_LAYOUT.playwrightConfig);
  if (existsSync(configPath) && !force) return false;
  ensureDir(dirname(configPath));
  writeFileSync(configPath, PLAYWRIGHT_CONFIG_BODY, 'utf-8');
  return true;
}

/**
 * 幂等追加 .gitignore 条目
 */
function ensureGitignore(cwd: string): boolean {
  const gitignorePath = join(cwd, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
  const lines = existing.split('\n');
  const missing = GITIGNORE_ADDITIONS.filter((entry) => !lines.some((l) => l.trim() === entry));

  if (missing.length === 0) return false;

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
  const newContent =
    existing + (needsLeadingNewline ? '\n' : '') + '# auto-test\n' + missing.join('\n') + '\n';
  writeFileSync(gitignorePath, newContent, 'utf-8');
  return true;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export async function initCommand(options: InitOptions): Promise<void> {
  const cwd = process.cwd();
  logger.info(`在 ${cwd} 初始化 auto-test 项目...`);

  const createdDirs = ensureDirs(cwd, DEFAULT_DIRECTORIES);
  logger.debug(`创建 ${createdDirs.length} 个目录`, { createdDirs });

  let wroteConfig: boolean;
  try {
    wroteConfig = ensureConfig(cwd, !!options.force);
  } catch (err) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `写入 ${STORAGE_LAYOUT.configFile} 失败: ${(err as Error).message}`,
      hint: '请确认当前目录有写权限',
    });
  }

  const wrotePlaywrightConfig = ensurePlaywrightConfig(cwd, !!options.force);

  const updatedGitignore = ensureGitignore(cwd);

  const nextSteps = [
    'npm install',
    'npx playwright install chromium',
    `auto-test models select        # 选定 LLM provider/model`,
    `auto-test generate "<测试需求描述>" --priority P0`,
  ];

  const result: InitResult = {
    ok: true,
    cwd,
    root: '.auto-test',
    configPath: STORAGE_LAYOUT.configFile,
    runnerConfigPath: STORAGE_LAYOUT.playwrightConfig,
    createdDirs,
    wroteConfig,
    wrotePlaywrightConfig,
    updatedGitignore,
    nextSteps,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  logger.info(`✓ 目录就绪（新建 ${createdDirs.length} 个）`);
  if (wroteConfig) {
    logger.info(`✓ 写入 ${STORAGE_LAYOUT.configFile}`);
  } else {
    logger.info(`○ ${STORAGE_LAYOUT.configFile} 已存在（用 --force 覆盖）`);
  }
  if (wrotePlaywrightConfig) {
    logger.info(`✓ 写入 ${STORAGE_LAYOUT.playwrightConfig}`);
  } else {
    logger.info(`○ ${STORAGE_LAYOUT.playwrightConfig} 已存在（用 --force 覆盖）`);
  }
  if (updatedGitignore) {
    logger.info(`✓ 追加 .gitignore 条目`);
  } else {
    logger.info(`○ .gitignore 条目已就绪`);
  }

  logger.info('下一步：');
  for (const step of nextSteps) {
    process.stdout.write(`  $ ${step}\n`);
  }
}