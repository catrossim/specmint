/**
 * init 子命令：在当前目录初始化 auto-test 项目
 *
 * 职责：
 * 1. 创建目录结构（tests、reports、examples、src 子目录等）
 * 2. 写入默认 auto-test.config.json（如不存在或 --force）
 * 3. 追加 .gitignore 条目（幂等）
 * 4. 打印下一步建议
 *
 * 不做 npm install / npx playwright install —— 这些需要外部副作用，
 * 由用户自行执行，避免 init 子命令网络/系统依赖。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { CliError, ExitCode } from '../utils/errors.js';

const DEFAULT_DIRECTORIES = [
  'tests',
  'tests/pages',
  'reports',
  'reports/runs',
  'examples',
  'src/commands',
  'src/agent',
  'src/store',
  'src/runner',
  'src/templates',
  'src/utils',
];

const DEFAULT_CONFIG_OBJECT = {
  version: '1',
  agent: {
    model: 'anthropic/claude-sonnet-latest',
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
    configPath: './playwright.config.ts',
    defaultBrowser: 'chromium',
    trace: 'on-first-retry' as const,
    screenshot: 'only-on-failure' as const,
  },
  storage: {
    casesDir: './tests',
    pageObjectsDir: './tests/pages',
    reportsDir: './reports',
  },
};

const GITIGNORE_ADDITIONS = [
  'node_modules/',
  'dist/',
  'reports/runs/*/.tmp/',
  'playwright-report/',
  'test-results/',
];

export interface InitOptions {
  force?: boolean;
  json?: boolean;
}

export interface InitResult {
  ok: true;
  cwd: string;
  createdDirs: string[];
  wroteConfig: boolean;
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
 * 写入 auto-test.config.json（已存在且无 --force 则跳过）
 */
function ensureConfig(cwd: string, force: boolean): boolean {
  const configPath = join(cwd, 'auto-test.config.json');
  if (existsSync(configPath) && !force) {
    return false;
  }
  writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG_OBJECT, null, 2) + '\n', 'utf-8');
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
      message: `写入 auto-test.config.json 失败: ${(err as Error).message}`,
      hint: '请确认当前目录有写权限',
    });
  }

  const updatedGitignore = ensureGitignore(cwd);

  const nextSteps = [
    'npm install',
    'npx playwright install chromium',
    `auto-test generate "<测试需求描述>"`,
  ];

  const result: InitResult = {
    ok: true,
    cwd,
    createdDirs,
    wroteConfig,
    updatedGitignore,
    nextSteps,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  logger.info(`✓ 目录就绪（新建 ${createdDirs.length} 个）`);
  if (wroteConfig) {
    logger.info(`✓ 写入 auto-test.config.json`);
  } else {
    logger.info(`○ auto-test.config.json 已存在（用 --force 覆盖）`);
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