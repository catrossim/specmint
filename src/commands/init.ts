/**
 * init 子命令：在当前目录初始化 specmint 项目
 *
 * 职责：
 * 1. 创建 .specmint/ 目录结构（cases、cases/pages、reports、reports/runs、auth、cache）
 * 2. 写入 .specmint/config.json（默认 runner.timeoutMs / browserChannel 等）
 * 3. 检测历史 init 产物（旧 .specmint/playwright.config.ts / specmint-reporter.ts / 占位 setup）
 *    如存在且非空，提示用户可手动删除（不影响运行，因为包内配置已接管）
 * 4. 幂等追加 .gitignore 条目
 * 5. 打印下一步建议
 *
 * 设计：
 * - 不再生成 .specmint/playwright.config.ts 与 specmint-reporter.ts —— 这些是包内部资源，
 *   由 dist/runner/playwright.config.{js,ts} 与 dist/runner/reporter.js 提供
 * - 不再生成 .specmint/auth/admin.setup.ts 占位 —— 用户需要时跑 `specmint auth init <name>`
 *   自助生成，避免占位文件失败连坐真实用例
 * - 不做 npm install / npx playwright install —— 这些需要外部副作用，由用户自行执行
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { logger } from '../utils/logger.js';
import { STORAGE_LAYOUT } from '../config.js';
import { CliError, ExitCode } from '../utils/errors.js';

const DEFAULT_DIRECTORIES = [
  '.specmint',
  '.specmint/cases',
  '.specmint/cases/pages',
  '.specmint/reports',
  '.specmint/reports/runs',
  '.specmint/auth',
  '.specmint/auth/storage',
  '.specmint/cache',
  '.specmint/cache/explore',
];

/**
 * 默认 .specmint/config.json 内容
 *
 * 用户可改：model（specmint models select）、defaultBrowser / auth / agent 等其他字段
 * 不应改：version（schema 版本）、storage 段（路径不可配置）
 */
const DEFAULT_CONFIG_OBJECT = {
  version: '1',
  agent: {
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
    /** 默认 retain-on-failure：heal 时 LLM 可结合页面现场定位。 */
    trace: 'retain-on-failure' as const,
    screenshot: 'only-on-failure' as const,
    /** 单用例超时（毫秒），默认 30s */
    timeoutMs: 30_000,
    /**
     * 浏览器通道：解决内网/受限环境无法下载 Playwright chromium 的痛点
     * - `auto`（默认）：chromium → chrome → msedge 检测链
     * - `chromium` / `chrome` / `msedge`：显式固定
     */
    browserChannel: 'auto' as const,
  },
};

const GITIGNORE_ADDITIONS = [
  '.specmint/reports/runs/',
  '.specmint/.env',
  '.specmint/cache/',
  'test-results/',
  'playwright-report/',
];

/**
 * 历史 init 产物（包内配置接管后不再生成；旧产物不会自动删，给用户提示）
 */
const LEGACY_FILES = [
  {
    path: STORAGE_LAYOUT.playwrightConfig,
    reason: '旧内联 Playwright 配置（含残缺 reporter 触发收尾断链），已由包内配置 dist/runner/playwright.config.{js,ts} 接管',
  },
  {
    path: '.specmint/specmint-reporter.ts',
    reason: '旧 reporter re-export，已被包内 dist/runner/reporter.js 直接 import 替代',
  },
  {
    path: `${STORAGE_LAYOUT.authDir}/admin.setup.ts`,
    reason: '占位 setup 可能失败连坐真实用例；按需用 `specmint auth init <name>` 生成',
  },
];

export interface InitOptions {
  force?: boolean;
  json?: boolean;
}

export interface InitResult {
  ok: true;
  cwd: string;
  root: string;
  configPath: string;
  createdDirs: string[];
  wroteConfig: boolean;
  updatedGitignore: boolean;
  /** 历史遗留文件列表（提示用户可手动删除，不影响运行） */
  legacyFiles: string[];
  /**
   * 用户项目里 playwright 依赖探测结果（peer 模式必需）
   * - key 为包名；值为检测到的版本，未装为 null
   * - 调用方（CICD / 集成测试）可据此判断是否需要先 `npm install playwright ...`
   */
  playwright: {
    '@playwright/test': string | null;
    playwright: string | null;
  };
  nextSteps: string[];
}

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

function ensureConfig(cwd: string, force: boolean): boolean {
  const configPath = join(cwd, STORAGE_LAYOUT.configFile);
  if (existsSync(configPath) && !force) return false;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG_OBJECT, null, 2) + '\n', 'utf-8');
  return true;
}

function detectLegacyFiles(cwd: string): string[] {
  const found: string[] = [];
  for (const entry of LEGACY_FILES) {
    const full = join(cwd, entry.path);
    if (existsSync(full)) found.push(entry.path);
  }
  return found;
}

function ensureGitignore(cwd: string): boolean {
  const gitignorePath = join(cwd, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
  const lines = existing.split('\n');
  const missing = GITIGNORE_ADDITIONS.filter((entry) => !lines.some((l) => l.trim() === entry));

  if (missing.length === 0) return false;

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
  const newContent =
    existing + (needsLeadingNewline ? '\n' : '') + '# specmint\n' + missing.join('\n') + '\n';
  writeFileSync(gitignorePath, newContent, 'utf-8');
  return true;
}

/**
 * 检测用户项目里是否已安装 playwright / @playwright/test
 *
 * 设计目的：
 * - specmint 是 peerDependencies 模式，自身不拖 playwright 进来；
 * - 用户必须自行决定版本；若检测不到，nextSteps 里给出明确命令
 * - 区分两种状态：未装 / 已装；已装时给出具体版本（便于排错"我用的哪个 playwright"）
 *
 * 用 createRequire(cwd 解析 require) 而不是顶层 require，确保从用户的 cwd 查找，
 * 避免误读到 specmint 包内的依赖（devDependencies 锁定 1.58.0）。
 */
type PlaywrightProbe = {
  test: boolean;
  core: boolean;
  testVersion: string | null;
  coreVersion: string | null;
};

function probePlaywright(cwd: string): PlaywrightProbe {
  const requireFromCwd = createRequire(join(cwd, 'package.json'));
  const probe = (pkg: 'playwright' | '@playwright/test'): { installed: boolean; version: string | null } => {
    try {
      const resolved = requireFromCwd.resolve(`${pkg}/package.json`);
      const pkgJson = JSON.parse(readFileSync(resolved, 'utf-8')) as { version?: string };
      return { installed: true, version: pkgJson.version ?? null };
    } catch {
      return { installed: false, version: null };
    }
  };
  const testPkg = probe('@playwright/test');
  const corePkg = probe('playwright');
  return {
    test: testPkg.installed,
    core: corePkg.installed,
    testVersion: testPkg.version,
    coreVersion: corePkg.version,
  };
}

export async function initCommand(options: InitOptions): Promise<void> {
  const cwd = process.cwd();
  logger.info(`在 ${cwd} 初始化 specmint 项目...`);

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

  const legacyFiles = detectLegacyFiles(cwd);
  const updatedGitignore = ensureGitignore(cwd);
  const playwrightProbe = probePlaywright(cwd);

  const playwrightHint = (() => {
    if (!playwrightProbe.test && !playwrightProbe.core) {
      return 'npm install -D playwright @playwright/test   # playwright 未检测到，specmint 用 peerDependencies，请自行安装并固定版本';
    }
    if (!playwrightProbe.test) {
      return `npm install -D @playwright/test@${playwrightProbe.coreVersion ?? '>=1.58.0'}   # playwright core 已装（${playwrightProbe.coreVersion ?? 'unknown'}），但缺 @playwright/test`;
    }
    if (!playwrightProbe.core) {
      return `npm install -D playwright@${playwrightProbe.testVersion ?? '>=1.58.0'}   # @playwright/test 已装（${playwrightProbe.testVersion ?? 'unknown'}），但缺 playwright core`;
    }
    return `playwright 版本检查：@playwright/test ${playwrightProbe.testVersion ?? '?'} · playwright core ${playwrightProbe.coreVersion ?? '?'}`;
  })();

  const nextSteps = [
    'npm install',
    playwrightHint,
    'npx playwright install chromium   # 或装系统 Chrome/Edge 走 auto 通道',
    'specmint models select',
    'specmint generate "<测试需求描述>" --priority P0',
  ];

  const result: InitResult = {
    ok: true,
    cwd,
    root: '.specmint',
    configPath: STORAGE_LAYOUT.configFile,
    createdDirs,
    wroteConfig,
    updatedGitignore,
    legacyFiles,
    playwright: {
      '@playwright/test': playwrightProbe.test ? (playwrightProbe.testVersion ?? 'unknown') : null,
      playwright: playwrightProbe.core ? (playwrightProbe.coreVersion ?? 'unknown') : null,
    },
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
  if (updatedGitignore) {
    logger.info(`✓ 追加 .gitignore 条目`);
  } else {
    logger.info(`○ .gitignore 条目已就绪`);
  }
  if (legacyFiles.length > 0) {
    logger.warn(`检测到历史 init 产物（已不影响运行，可手动删除）：`);
    for (const f of legacyFiles) logger.warn(`  - ${f}`);
  }

  // 强制提醒：若用户完全没装 playwright，run/generate 命令会立刻报"找不到模块"，
  // 提前给出 blocker 比盲目给"下一步"更友好。
  if (!playwrightProbe.test && !playwrightProbe.core) {
    logger.warn('⚠ 未检测到 playwright / @playwright/test —— 见 nextSteps 第 2 步');
  }

  logger.info('下一步：');
  for (const step of nextSteps) {
    process.stdout.write(`  $ ${step}\n`);
  }
}