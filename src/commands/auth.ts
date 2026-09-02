/**
 * auth 子命令：管理登录 setup 与 storageState
 *
 * 目录约定（B1 决策）：
 *   .specmint/auth/<name>.setup.ts
 *   .specmint/auth/storage/<name>.json
 *
 * 设计要点：
 * - name 强制 kebab-case
 * - storageState 路径由 name 派生
 * - refresh 调用 Playwright --project=auth-setup 单独跑
 * - generate 复用 PI 流程，prompt 强化为"写 setup 文件"
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { STORAGE_LAYOUT } from '../config.js';
import { logger } from '../utils/logger.js';
import { CliError, ExitCode } from '../utils/errors.js';
import { createStores } from '../store/index.js';
import { createAgentSession } from '../agent/session.js';
import { createSetupTools, SETUP_TOOL_NAMES } from '../agent/tools.js';
import { buildGenerateSetupPrompt } from '../agent/prompts.js';
import { loadConfig } from '../config.js';
import { resolveRunnerConfigPath } from '../runner/config-resolver.js';
import { buildSpawnEnv } from '../runner/spawn-env.js';
import { spawnPlaywrightTest } from '../runner/spawn-playwright.js';

const SETUP_FILE_RE = /\.setup\.ts$/;
const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 默认登录态过期阈值（小时）；超过则 warn 但不阻塞 */
const AUTH_EXPIRY_HOURS_DEFAULT = 24;
/** 通用明文密码命中模式（仅匹配短非空字符串，避免误伤长 token / uuid） */
const PLAINTEXT_PASSWORD_PATTERNS = [
  /['"](?:password|passwd|pwd|secret)['"]\s*[:,]\s*['"]([^'"]{4,40})['"]/i,
  /\.fill\(\s*['"]([^'"]{4,40})['"]\s*\)/i, // page.getByLabel().fill('12345678') 这种
];

export interface AuthListOptions { json?: boolean }
export interface AuthInitOptions { json?: boolean }
export interface AuthRefreshOptions { json?: boolean }
export interface AuthGenerateOptions {
  name?: string;
  url?: string;
  json?: boolean;
}
export interface AuthDoctorOptions {
  json?: boolean;
  /** 过期阈值（小时），覆盖默认值 24 */
  expiryHours?: number;
}
export interface AuthDebugOptions {
  name?: string;
  url?: string;
  json?: boolean;
}
export interface AuthLintOptions { json?: boolean }
export interface AuthMatrixOptions {
  /** 逗号分隔的角色名，例如 `--roles admin,editor,guest`；缺省 = 列出所有 */
  roles?: string;
  /** 透传给 `specmint run --grep` */
  grep?: string;
  json?: boolean;
}

export interface AuthEntry {
  name: string;
  setupPath: string;
  storageStatePath: string;
  hasStorageState: boolean;
  /** 自 .json 写入以来小时数；缺失时为 null（说明从未 refresh 或文件被外部改） */
  ageHours: number | null;
  /** storageState 内的 Cookie 数量；缺失时为 null */
  cookieCount: number | null;
  /** Cookie 域名集合（去重） */
  cookieDomains: string[] | null;
  /** setup 文件是否包含 toHaveURL / storageState 调用 */
  setupAssertions: { hasStorageStateCall: boolean; hasSuccessAssert: boolean };
}

export interface AuthDoctorIssue {
  level: 'ok' | 'warn' | 'error';
  check: string;
  message: string;
  hint?: string;
}

export interface AuthDoctorReport {
  ok: boolean;
  checkedAt: string;
  expiryHours: number;
  baseURL: string | null;
  issues: AuthDoctorIssue[];
  entries: AuthEntry[];
}

/** metadata 落盘结构：与 storageState 同目录，<name>.meta.json */
export interface AuthMetadata {
  lastRefreshAt: string;   // ISO 8601
  refreshDurationMs?: number;
  refreshedBy?: 'cli' | 'ci' | 'manual';
  exitCode?: number;
}

function ensureAuthDir(): { authDir: string; storageDir: string } {
  const cwd = process.cwd();
  const authDir = join(cwd, STORAGE_LAYOUT.authDir);
  const storageDir = join(cwd, STORAGE_LAYOUT.authStorage);
  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });
  if (!existsSync(storageDir)) mkdirSync(storageDir, { recursive: true });
  return { authDir, storageDir };
}

/** 读取 <name>.meta.json；缺失/损坏返回 null */
function readAuthMetadata(storageDir: string, name: string): AuthMetadata | null {
  const metaPath = join(storageDir, `${name}.meta.json`);
  if (!existsSync(metaPath)) return null;
  try {
    const raw = readFileSync(metaPath, 'utf-8');
    const parsed = JSON.parse(raw) as AuthMetadata;
    if (typeof parsed.lastRefreshAt !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 写入 metadata；失败仅 warn，不抛（metadata 缺失不影响功能） */
function writeAuthMetadata(
  storageDir: string,
  name: string,
  meta: AuthMetadata,
): void {
  try {
    const metaPath = join(storageDir, `${name}.meta.json`);
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
  } catch (err) {
    logger.warn(`写入 metadata 失败：${(err as Error).message}`);
  }
}

/** 解析 storageState JSON，返回 cookie 数 + 域名集合 */
function inspectStorageState(jsonPath: string): { cookieCount: number; domains: string[] } | null {
  if (!existsSync(jsonPath)) return null;
  try {
    const raw = readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { cookies?: Array<{ domain?: string }> };
    const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
    const domains = Array.from(
      new Set(cookies.map((c) => (c.domain ?? '').toLowerCase()).filter(Boolean)),
    );
    return { cookieCount: cookies.length, domains };
  } catch {
    return null;
  }
}

/** 扫描 setup 文件的关键模式（不解析 AST，足够 lint 用） */
function inspectSetupAssertions(setupPath: string): {
  hasStorageStateCall: boolean;
  hasSuccessAssert: boolean;
} {
  if (!existsSync(setupPath)) return { hasStorageStateCall: false, hasSuccessAssert: false };
  const src = readFileSync(setupPath, 'utf-8');
  return {
    hasStorageStateCall: /\.storageState\s*\(/.test(src),
    hasSuccessAssert: /expect\s*\(\s*page\s*\)\s*\.toHaveURL\s*\(/.test(src),
  };
}

/** 计算 entry 完整视图（含 metadata / cookie / setup 扫描），给 list/doctor 共用 */
function collectEntries(): AuthEntry[] {
  const cwd = process.cwd();
  const authDir = join(cwd, STORAGE_LAYOUT.authDir);
  const storageDir = join(cwd, STORAGE_LAYOUT.authStorage);
  if (!existsSync(authDir)) return [];

  const setupFiles = readdirSync(authDir)
    .filter((f) => SETUP_FILE_RE.test(f))
    .sort();
  const now = Date.now();

  return setupFiles.map((setupFile) => {
    const name = setupFile.replace(SETUP_FILE_RE, '');
    const setupPath = join(authDir, setupFile);
    const storageStatePath = join(storageDir, `${name}.json`);
    const hasStorageState = existsSync(storageStatePath);
    const meta = readAuthMetadata(storageDir, name);
    const ageHours = meta
      ? Math.round(((now - new Date(meta.lastRefreshAt).getTime()) / 3_600_000) * 10) / 10
      : null;
    const inspection = hasStorageState ? inspectStorageState(storageStatePath) : null;
    return {
      name,
      setupPath,
      storageStatePath,
      hasStorageState,
      ageHours,
      cookieCount: inspection?.cookieCount ?? null,
      cookieDomains: inspection?.domains ?? null,
      setupAssertions: inspectSetupAssertions(setupPath),
    };
  });
}

/** 用 glob 模式扫 setup 文件里的明文密码命中 */
function scanPlaintextPassword(setupPath: string): string[] {
  if (!existsSync(setupPath)) return [];
  const src = readFileSync(setupPath, 'utf-8');
  const hits: string[] = [];
  for (const re of PLAINTEXT_PASSWORD_PATTERNS) {
    const m = src.match(re);
    if (m && m[1]) hits.push(m[1]);
  }
  return hits;
}

/** 把 config.baseURL 的 host 提出来做 Cookie 域名匹配检查 */
function baseURLHost(baseURL: string | undefined | null): string | null {
  if (!baseURL) return null;
  try {
    return new URL(baseURL).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Cookie domain 是否覆盖 baseURL host（domain 含 .example.com 或 == host 视为匹配） */
function cookieDomainMatches(cookieDomain: string, host: string): boolean {
  const cd = cookieDomain.toLowerCase();
  if (cd === host) return true;
  if (cd.startsWith('.') && host.endsWith(cd)) return true;
  // 注意：这里故意不做 IP 字面量 / 端口区分；doctor 给出 hint 即可
  return false;
}

function validateName(name: string): void {
  if (!KEBAB_CASE_RE.test(name)) {
    throw new CliError({
      code: ExitCode.USAGE_ERROR,
      message: `auth name 必须是 kebab-case：${name}`,
      hint: '只允许小写字母、数字、连字符，例如：admin / operator / anonymous',
    });
  }
}

/**
 * 扫描 .specmint/auth/*.setup.ts，列出所有 auth 角色（带 metadata / cookie / setup 完整性）。
 *
 * cwd 参数保留向后兼容；实际扫描基于 process.cwd()，与 STORAGE_LAYOUT 锚定一致。
 */
export function listAuth(cwd: string = process.cwd()): AuthEntry[] {
  // collectEntries 已基于 process.cwd()；此处保留 cwd 入参仅用于外部调用兼容
  void cwd;
  return collectEntries();
}

export async function authListCommand(options: AuthListOptions): Promise<void> {
  const entries = listAuth();
  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, count: entries.length, entries }, null, 2) + '\n');
    return;
  }
  if (entries.length === 0) {
    logger.info('当前未配置 auth（.specmint/auth/ 为空）。用 `specmint auth init <name>` 创建。');
    return;
  }
  for (const e of entries) {
    const storageMark = e.hasStorageState ? '✓' : '✗';
    const setupOk =
      e.setupAssertions.hasStorageStateCall && e.setupAssertions.hasSuccessAssert;
    const setupMark = setupOk ? '✓' : '!';
    const age =
      e.ageHours === null
        ? 'never'
        : e.ageHours < 1
          ? `${Math.round(e.ageHours * 60)}m ago`
          : `${e.ageHours.toFixed(1)}h ago`;
    const cookie = e.cookieCount === null ? '—' : `${e.cookieCount} cookies`;
    process.stdout.write(
      `  ${storageMark} ${e.name.padEnd(16)} storage ${age.padStart(10)}  ${cookie.padStart(14)}\n`,
    );
    process.stdout.write(
      `  ${setupMark} ${' '.repeat(16)} setup ${
        e.setupAssertions.hasStorageStateCall ? 'storageState' : 'NO-storageState'
      } · ${
        e.setupAssertions.hasSuccessAssert ? 'assert' : 'NO-assert'
      }\n`,
    );
  }
}

/**
 * auth init：生成 setup 文件模板（手写模式起点）。
 */
export async function authInitCommand(
  name: string,
  options: AuthInitOptions,
): Promise<void> {
  validateName(name);
  ensureAuthDir();
  const cwd = process.cwd();
  const setupPath = join(cwd, STORAGE_LAYOUT.authDir, `${name}.setup.ts`);
  if (existsSync(setupPath)) {
    throw new CliError({
      code: ExitCode.ALREADY_EXISTS,
      message: `auth ${name} 已存在：${setupPath}`,
    });
  }
  const storageStatePath = join(cwd, STORAGE_LAYOUT.authStorage, `${name}.json`);
  // 相对 cwd，并统一转为正斜杠（Windows 下 relative() 默认返回反斜杠路径）
  // 与 case-store.ts 中 pathRelative(...).replace(/\\/g, '/') 范式一致
  const storageRel = relative(cwd, storageStatePath).replace(/\\/g, '/');
  const template = `import { test as setup, expect } from '@playwright/test';

/**
 * ${name} 登录流程（手写模板）
 *
 * 流程结束后必须调用 \`page.context().storageState({ path })\` 保存登录态。
 * storageState 路径固定为：${storageRel}
 *
 * 推荐：登录成功后用 \`await expect(page).toHaveURL(/dashboard/)\` 等做断言，
 * 避免登录失败但 storageState 仍然生成（导致 e2e 用例莫名其妙失败）。
 */
const STORAGE_STATE = '${storageRel}';

setup('${name} login', async ({ page }) => {
  await page.goto('/login');

  // TODO: 填入登录步骤
  // await page.getByLabel('用户名').fill('${name}');
  // await page.getByLabel('密码').fill(process.env.${name.toUpperCase().replace(/-/g, '_')}_PASSWORD ?? '');
  // await page.getByRole('button', { name: '登录' }).click();
  // await expect(page).toHaveURL(/dashboard/);

  await page.context().storageState({ path: STORAGE_STATE });
});
`;

  try {
    writeFileSync(setupPath, template, 'utf-8');
  } catch (err) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `写入 ${setupPath} 失败：${(err as Error).message}`,
    });
  }

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, setupPath, storageStatePath: storageRel }, null, 2) + '\n');
    return;
  }
  logger.info(`✓ 已生成 ${setupPath}`);
  logger.info(`  下一步：编辑该文件填入登录步骤，然后运行 \`specmint auth refresh ${name}\` 生成 storageState`);
}

/**
 * auth refresh：单独跑 setup 文件刷新 storageState。
 *
 * 实现：经 spawn-playwright.ts 助手启动 \`playwright test --config <runner> --project=auth-setup --grep "<name>"\`
 * （优先 createRequire 直连用户项目 CLI，回退 npx；Windows 兼容）
 */
export async function authRefreshCommand(
  name: string,
  options: AuthRefreshOptions,
): Promise<void> {
  validateName(name);
  const cwd = process.cwd();
  const setupPath = join(cwd, STORAGE_LAYOUT.authDir, `${name}.setup.ts`);
  if (!existsSync(setupPath)) {
    throw new CliError({
      code: ExitCode.NOT_FOUND,
      message: `找不到 ${setupPath}，请先运行 \`specmint auth init ${name}\` 或 auth generate`,
    });
  }
  const { storage } = createStores(cwd);
  const configPath = join(cwd, STORAGE_LAYOUT.configFile);
  if (!existsSync(configPath)) {
    throw new CliError({
      code: ExitCode.NOT_FOUND,
      message: `找不到 ${STORAGE_LAYOUT.configFile}，请先运行 \`specmint init\``,
    });
  }
  const config = loadConfig(cwd);

  const runnerConfigPath = resolveRunnerConfigPath();
  const { env } = buildSpawnEnv({
    cwd,
    casesDir: storage.casesDir,
    reportsDir: storage.reportsDir,
    authDir: storage.authDir,
    configPath: storage.configPath,
    runId: `auth-refresh-${name}-${Date.now()}`,
    outputDir: storage.reportsDir,
    jsonOutputFile: join(storage.reportsDir, '.tmp'),
    config,
  });

  logger.info(`正在 refresh ${name}...`);
  const refreshStart = Date.now();
  const refreshResult = await spawnPlaywrightTest(
    ['--config', runnerConfigPath, '--project=auth-setup', '--grep', name],
    { cwd, env },
  );
  const exitCode = refreshResult.exitCode;
  const refreshDurationMs = Date.now() - refreshStart;

  // 写 metadata：成功 / 失败都落盘，doctor 才能给出"已过期 / 已失败"区分
  const storageDir = join(cwd, STORAGE_LAYOUT.authStorage);
  writeAuthMetadata(storageDir, name, {
    lastRefreshAt: new Date().toISOString(),
    refreshDurationMs,
    refreshedBy: process.env.CI ? 'ci' : 'cli',
    exitCode,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: exitCode === 0, exitCode, refreshDurationMs }, null, 2) + '\n');
  }
  if (exitCode !== 0) {
    process.exitCode = ExitCode.AUTH_LOGIN_FAILED;
    throw new CliError({
      code: ExitCode.AUTH_LOGIN_FAILED,
      message: refreshResult.signal
        ? `auth refresh ${name} 被信号 ${refreshResult.signal} 终止`
        : `auth refresh ${name} 登录步骤失败（exit ${exitCode}）`,
      hint: refreshResult.signal
        ? '子进程被外部信号终止（如 Ctrl+C 或被杀）；非测试断言失败，请重试或检查系统资源'
        : '用 `specmint auth debug ' + name + '` 打开 headed 浏览器一步步看登录过程；或 `specmint auth lint ' + name + '` 检查 setup 文件',
    });
  }
  logger.info(`✓ storageState 已刷新：${join(storageDir, `${name}.json`)}（${(refreshDurationMs / 1000).toFixed(1)}s）`);
}

/**
 * auth generate：PI 生成 setup 文件。
 *
 * 复用 generate.ts 的 PI 流程，但 prompt 强化为"写 setup.ts"。
 *
 * 阶段 2.2 占位：完整 PI 集成放到阶段 2 末尾验证后做；先用 init 手写模板起步。
 */
export async function authGenerateCommand(
  description: string,
  options: AuthGenerateOptions,
): Promise<void> {
  if (!description || description.trim().length === 0) {
    throw new CliError({ code: ExitCode.USAGE_ERROR, message: '缺少描述' });
  }
  if (!options.name || !KEBAB_CASE_RE.test(options.name)) {
    throw new CliError({
      code: ExitCode.USAGE_ERROR,
      message: `必须传 --name <kebab-case>`,
    });
  }
  await runAuthGenerate(description, options);
}

async function runAuthGenerate(description: string, options: AuthGenerateOptions): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const { storage } = createStores(cwd);

  const setupPath = join(cwd, STORAGE_LAYOUT.authDir, `${options.name}.setup.ts`);
  if (existsSync(setupPath)) {
    throw new CliError({
      code: ExitCode.ALREADY_EXISTS,
      message: `auth ${options.name} 已存在：${setupPath}`,
      hint: '如需覆盖请先删除或用 auth init 重命名',
    });
  }

  const setupTools = createSetupTools({
    authDir: storage.authDir,
    storageStateAbs: join(storage.authStorage, `${options.name}.json`),
    url: options.url,
  });

  const prompt = buildGenerateSetupPrompt({
    description,
    name: options.name!,
    url: options.url ?? null,
    storageStateRel: `.specmint/auth/storage/${options.name}.json`,
  });

  const session = await createAgentSession({
    model: config.agent.model,
    customTools: setupTools,
    toolsAllowlist: [...SETUP_TOOL_NAMES],
    onToolCall: (event) => {
      const name = (event.input as { name?: unknown }).name;
      logger.info(`tool_call: ${event.name}${name ? `(${String(name)})` : ''}`);
    },
  });

  await session.prompt(prompt);
  logger.info(`✓ setup ${options.name} 已生成：${setupPath}`);
  logger.info(`  下一步：运行 \`specmint auth refresh ${options.name}\` 生成 storageState`);
}

// ===========================================================================
// 阶段 4 UX 改进：doctor / debug / lint / matrix
// ===========================================================================

/**
 * auth doctor：一行诊断所有 auth 状态。
 *
 * 检查项：
 *  1. storageState 文件存在
 *  2. metadata 时长（ageHours > 阈值 → warn）
 *  3. setup 文件包含 storageState 调用 + 登录成功断言
 *  4. Cookie 域名与 config.baseURL 匹配
 *  5. config 里 auth.storageState 指向了有效 entry
 *
 * 退出码：
 *  - OK (0)：无 error 级 issue
 *  - GENERIC_ERROR (1)：有 error 级 issue
 *  - warn 不影响退出码（让 CI 可以 `doctor || true`）
 */
export async function authDoctorCommand(options: AuthDoctorOptions): Promise<void> {
  const cwd = process.cwd();
  const expiryHours = options.expiryHours ?? AUTH_EXPIRY_HOURS_DEFAULT;
  const config = loadConfig(cwd);
  const baseURL = (config as { runner?: { baseURL?: string }; baseURL?: string })
    .runner?.baseURL ?? (config as { baseURL?: string }).baseURL ?? null;
  const baseHost = baseURLHost(baseURL);
  const entries = collectEntries();
  const issues: AuthDoctorIssue[] = [];

  // 配置侧：auth.storageState 是否指向某个 entry
  const cfgAuth = (config as { auth?: { storageState?: string } }).auth;
  const configuredPath = cfgAuth?.storageState?.replace(/\$\{[^}]+\}/g, 'ENV');
  const configuredEntry =
    entries.find((e) => e.storageStatePath.endsWith(`${configuredPath ?? ''}`.replace(/^.*\//, ''))) ??
    entries.find((e) => relative(cwd, e.storageStatePath).replace(/\\/g, '/') === configuredPath) ??
    null;
  if (configuredPath && !configuredEntry) {
    issues.push({
      level: 'warn',
      check: 'config.auth.storageState',
      message: `config 中指定的 storageState 未找到对应 entry: ${configuredPath}`,
      hint: '运行 `specmint auth list` 查看已有角色，确认 config.auth.storageState 路径正确',
    });
  }

  for (const e of entries) {
    const prefix = `[${e.name}]`;
    if (!e.hasStorageState) {
      issues.push({
        level: 'error',
        check: 'storageState',
        message: `${prefix} storageState 缺失: ${e.storageStatePath}`,
        hint: `运行 \`specmint auth refresh ${e.name}\` 生成`,
      });
      continue;
    }
    if (e.ageHours !== null && e.ageHours > expiryHours) {
      issues.push({
        level: 'warn',
        check: 'freshness',
        message: `${prefix} storageState 已 ${e.ageHours.toFixed(1)}h 未刷新（阈值 ${expiryHours}h）`,
        hint: `运行 \`specmint auth refresh ${e.name}\` 重新登录`,
      });
    }
    if (e.cookieCount === 0) {
      issues.push({
        level: 'error',
        check: 'cookies',
        message: `${prefix} storageState 含 0 个 Cookie，登录可能未真正成功`,
        hint: '编辑 setup 文件确保有 expect(page).toHaveURL(/dashboard/) 断言；用 `specmint auth debug ' + e.name + '` 调试',
      });
    } else if (baseHost && e.cookieDomains && e.cookieDomains.length > 0) {
      const matched = e.cookieDomains.some((d) => cookieDomainMatches(d, baseHost));
      if (!matched) {
        issues.push({
          level: 'error',
          check: 'domain',
          message: `${prefix} Cookie 域名 [${e.cookieDomains.join(', ')}] 与 baseURL host "${baseHost}" 不匹配`,
          hint: '检查 setup 文件登录后是否在正确的子域上；或更新 config.runner.baseURL',
        });
      }
    }
    if (!e.setupAssertions.hasStorageStateCall) {
      issues.push({
        level: 'error',
        check: 'setup.storageStateCall',
        message: `${prefix} setup 文件缺少 storageState() 调用，refresh 后不会写 Cookie`,
        hint: '在 setup 末尾加 `await page.context().storageState({ path: <path> })`',
      });
    }
    if (!e.setupAssertions.hasSuccessAssert) {
      issues.push({
        level: 'warn',
        check: 'setup.successAssert',
        message: `${prefix} setup 文件缺少 expect(page).toHaveURL(...) 断言，登录失败会静默写入空 Cookie`,
        hint: '在登录成功后加 `await expect(page).toHaveURL(/dashboard/)`',
      });
    }
  }

  const ok = issues.every((i) => i.level !== 'error');
  const report: AuthDoctorReport = {
    ok,
    checkedAt: new Date().toISOString(),
    expiryHours,
    baseURL: baseURL ?? null,
    issues,
    entries,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!ok) process.exitCode = ExitCode.GENERIC_ERROR;
    return;
  }

  // 友好输出
  logger.info(`auth doctor @ ${report.checkedAt}`);
  logger.info(`  baseURL: ${baseURL ?? '(未配置)'}`);
  logger.info(`  阈值: ${expiryHours}h`);
  logger.info(`  entries: ${entries.length}`);
  if (entries.length === 0) {
    logger.warn('未配置任何 auth role。运行 `specmint auth init <name>` 开始。');
    return;
  }

  for (const e of entries) {
    const storageMark = e.hasStorageState ? '✓' : '✗';
    const age = e.ageHours === null ? 'never' : `${e.ageHours.toFixed(1)}h`;
    const cookies = e.cookieCount === null ? '—' : `${e.cookieCount}`;
    const setupOk =
      e.setupAssertions.hasStorageStateCall && e.setupAssertions.hasSuccessAssert;
    const setupMark = setupOk ? '✓' : '!';
    logger.info(
      `  ${storageMark} ${e.name.padEnd(16)} ${age.padStart(8)}  cookies=${cookies.padStart(3)}  setup=${setupMark}`,
    );
  }

  if (issues.length === 0) {
    logger.info('✓ 所有检查通过');
    return;
  }
  for (const i of issues) {
    const tag = i.level === 'error' ? '✗' : i.level === 'warn' ? '⚠' : '✓';
    logger.info(`  ${tag} ${i.check}: ${i.message}`);
    if (i.hint) logger.info(`     hint: ${i.hint}`);
  }
  if (!ok) {
    process.exitCode = ExitCode.GENERIC_ERROR;
    logger.error('doctor 发现 error 级 issue，退出码 1');
  }
}

/**
 * auth debug：把 setup 文件用 headed + 慢动作模式跑一遍，便于人工观察。
 *
 * 设计：
 *  - 不复用 spawnPlaywrightTest（避免与正式 refresh 行为纠缠）
 *  - 直接 spawn `playwright test --headed --project=auth-setup --grep <name>`，
 *    慢动作 1000ms，setup 结束后进程自然退出
 *  - 不写 metadata（debug 是排错动作，不应污染 doctor 视图）
 */
export async function authDebugCommand(
  name: string,
  options: AuthDebugOptions,
): Promise<void> {
  validateName(name);
  const cwd = process.cwd();
  const setupPath = join(cwd, STORAGE_LAYOUT.authDir, `${name}.setup.ts`);
  if (!existsSync(setupPath)) {
    throw new CliError({
      code: ExitCode.NOT_FOUND,
      message: `setup 文件不存在：${setupPath}`,
      hint: `运行 \`specmint auth init ${name}\` 创建；或用 \`specmint auth generate --name ${name} "<描述>"\` 让 PI 起草`,
    });
  }
  const config = loadConfig(cwd);
  const runnerConfigPath = resolveRunnerConfigPath();
  const { env: envRecord } = buildSpawnEnv({
    cwd,
    casesDir: '',
    reportsDir: '',
    authDir: '',
    configPath: '',
    runId: `auth-debug-${name}-${Date.now()}`,
    outputDir: '',
    jsonOutputFile: '',
    config,
  });
  logger.info(`🐞 debug ${name}（headed 模式，慢动作 1000ms）`);
  logger.info(`   提示：以 headed + 慢动作模式人工观察登录流程，setup 结束后浏览器自动关闭。`);
  const args = [
    'test',
    '--config',
    runnerConfigPath,
    '--project=auth-setup',
    '--grep',
    name,
    '--headed',
    '--slow-mo=1000',
  ];
  const child = spawn('npx', ['playwright', ...args], {
    cwd,
    env: envRecord as NodeJS.ProcessEnv,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  // 等子进程退出
  const code = await new Promise<number>((resolve) => {
    child.on('exit', (c) => resolve(c ?? 0));
  });
  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: code === 0, exitCode: code }, null, 2) + '\n');
  }
  if (code !== 0) {
    process.exitCode = ExitCode.AUTH_LOGIN_FAILED;
  }
}

/**
 * auth lint：静态扫描 setup 文件，输出违规清单。
 *
 * 检查：
 *  - 明文密码（fill('12345678') / password: 'xxx'）
 *  - 缺 storageState() 调用
 *  - 缺登录成功断言
 *  - setup 文件存在但 storageState 不存在
 *
 * 退出码：AUTH_INCOMPLETE_SETUP（13）有违规 / 0 全部通过
 */
export async function authLintCommand(options: AuthLintOptions): Promise<void> {
  const entries = collectEntries();
  type LintFinding = {
    role: string;
    level: 'error' | 'warn';
    rule: string;
    message: string;
    detail?: string;
  };
  const findings: LintFinding[] = [];

  for (const e of entries) {
    const passwords = scanPlaintextPassword(e.setupPath);
    if (passwords.length > 0) {
      findings.push({
        role: e.name,
        level: 'warn',
        rule: 'plaintext-password',
        message: `setup 文件疑似含明文密码（命中 ${passwords.length} 处，启发式判断）`,
        detail: passwords.map((p) => `"${p.slice(0, 3)}***(${p.length}字符)"`).join(', '),
      });
    }
    if (!e.setupAssertions.hasStorageStateCall) {
      findings.push({
        role: e.name,
        level: 'error',
        rule: 'missing-storageState-call',
        message: 'setup 文件缺少 storageState() 调用，refresh 不会写 Cookie',
      });
    }
    if (!e.setupAssertions.hasSuccessAssert) {
      findings.push({
        role: e.name,
        level: 'warn',
        rule: 'missing-success-assert',
        message: 'setup 文件缺少 expect(page).toHaveURL(...) 断言',
      });
    }
    if (!e.hasStorageState) {
      findings.push({
        role: e.name,
        level: 'error',
        rule: 'storageState-missing',
        message: `storageState 不存在: ${e.storageStatePath}`,
      });
    }
  }

  if (options.json) {
    const ok = findings.every((f) => f.level !== 'error');
    process.stdout.write(JSON.stringify({ ok, count: findings.length, findings }, null, 2) + '\n');
    if (!ok) process.exitCode = ExitCode.AUTH_INCOMPLETE_SETUP;
    return;
  }

  if (entries.length === 0) {
    logger.info('未找到任何 auth setup 文件，跳过 lint');
    return;
  }
  if (findings.length === 0) {
    logger.info(`✓ ${entries.length} 个 auth role 全部通过 lint`);
    return;
  }
  for (const f of findings) {
    const tag = f.level === 'error' ? '✗' : '⚠';
    logger.info(`  ${tag} [${f.role}] ${f.rule}: ${f.message}`);
    if (f.detail) logger.info(`     ${f.detail}`);
  }
  const errCount = findings.filter((f) => f.level === 'error').length;
  if (errCount > 0) {
    process.exitCode = ExitCode.AUTH_INCOMPLETE_SETUP;
    logger.error(`lint 发现 ${errCount} 个 error 级问题`);
  }
}

/**
 * auth matrix：多角色矩阵跑，对比各角色结果。
 *
 * 策略：多次 spawn `specmint run --auth <role> --grep <pattern>`，收集每轮的
 * passed/failed 计数，输出对齐表格。
 *
 * 限制：
 *  - 不复用 specmint run 内部逻辑（避免循环依赖），直接 spawn 进程
 *  - 单角色失败不影响后续角色继续跑（部分失败仍出矩阵）
 *  - 总耗时 = 所有角色耗时之和（不并行；CI 上通常角色少，串行足够）
 */
export async function authMatrixCommand(options: AuthMatrixOptions): Promise<void> {
  const cwd = process.cwd();
  const entries = collectEntries();
  let roles = options.roles
    ? options.roles.split(',').map((r) => r.trim()).filter(Boolean)
    : entries.map((e) => e.name);

  // 过滤：只保留有 storageState 的角色（否则必失败）
  roles = roles.filter((r) => {
    const e = entries.find((x) => x.name === r);
    if (!e) {
      logger.warn(`role "${r}" 不在 entries 中，跳过`);
      return false;
    }
    if (!e.hasStorageState) {
      logger.warn(`role "${r}" 的 storageState 不存在，跳过（先跑 \`specmint auth refresh ${r}\`）`);
      return false;
    }
    return true;
  });

  if (roles.length === 0) {
    logger.info('无可跑的角色，退出');
    return;
  }

  logger.info(`矩阵跑 ${roles.length} 个角色${options.grep ? `（grep=${options.grep}）` : ''}`);
  type MatrixRow = {
    role: string;
    exitCode: number;
    passed: number;
    failed: number;
    durationMs: number;
    signal: NodeJS.Signals | null;
  };
  const rows: MatrixRow[] = [];

  for (const role of roles) {
    logger.info(`→ ${role} ...`);
    const start = Date.now();
    const args = ['run', '--auth', role];
    if (options.grep) args.push('--grep', options.grep);
    // 用单次 spawn 收集输出，避免 stdio: 'pipe' + 'inherit' 混合造成的类型推导断裂
    let capturedStdout = '';
    const exitInfo: { code: number; signal: NodeJS.Signals | null } = await new Promise(
      (resolve) => {
        const child = spawn('npx', ['specmint', ...args], {
          cwd,
          env: process.env,
          stdio: ['ignore', 'pipe', 'inherit'],
          shell: process.platform === 'win32',
        });
        child.stdout?.on('data', (b: Buffer) => {
          const s = b.toString();
          capturedStdout += s;
        });
        child.on('exit', (code, signal) => {
          resolve({ code: code ?? 0, signal });
        });
        child.on('error', () => {
          resolve({ code: 1, signal: null });
        });
      },
    );
    const dur = Date.now() - start;
    // Playwright 摘要行固定在 stdout 末尾（如「  5 passed (2.3s)」「  2 flaky, 1 failed」），
    // 取最后一次匹配：既兼容 flaky/skipped 前缀，又排除用例标题中偶然出现的 "N passed" 字样；
    // 解析不到时 warn 而非静默计 0（避免摘要格式变化导致矩阵假绿）
    // 用正则字面量而非 new RegExp(模板字符串)：模板字符串中 \d 会被求值为普通字符 d
    const lastCount = (re: RegExp): number | null => {
      const matches = [...capturedStdout.matchAll(re)];
      const last = matches[matches.length - 1];
      return last ? Number(last[1]) : null;
    };
    const passed = lastCount(/(\d+)\s+passed\b/g);
    const failed = lastCount(/(\d+)\s+failed\b/g);
    if (passed === null || failed === null) {
      logger.warn(
        `auth=${role} 未能从子进程输出解析到测试计数（passed=${passed ?? '?'} failed=${failed ?? '?'}），Playwright 摘要格式可能已变化`,
      );
    }
    rows.push({
      role,
      exitCode: exitInfo.code,
      passed: passed ?? 0,
      failed: failed ?? 0,
      durationMs: dur,
      signal: exitInfo.signal,
    });
  }

  const allOk = rows.every((r) => r.exitCode === 0);
  const matrixReport = {
    ok: allOk,
    grep: options.grep ?? null,
    roles: rows,
    durationMs: rows.reduce((s, r) => s + r.durationMs, 0),
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(matrixReport, null, 2) + '\n');
    if (!allOk) process.exitCode = ExitCode.TEST_FAILED;
    return;
  }

  logger.info('');
  // 角色列动态宽度：role 名超过 12 字符时表格不错位
  const roleWidth = Math.max(12, ...rows.map((r) => r.role.length));
  logger.info(`┌${'─'.repeat(roleWidth + 2)}┬────────┬────────┬────────┬──────────┐`);
  logger.info(`│ ${'role'.padEnd(roleWidth)} │ passed │ failed │  exit  │ duration │`);
  logger.info(`├${'─'.repeat(roleWidth + 2)}┼────────┼────────┼────────┼──────────┤`);
  for (const r of rows) {
    logger.info(
      `│ ${r.role.padEnd(roleWidth)} │ ${String(r.passed).padStart(6)} │ ${String(r.failed).padStart(6)} │ ${String(r.exitCode).padStart(6)} │ ${(r.durationMs / 1000).toFixed(1).padStart(7)}s │`,
    );
  }
  logger.info(`└${'─'.repeat(roleWidth + 2)}┴────────┴────────┴────────┴──────────┘`);
  if (!allOk) {
    process.exitCode = ExitCode.TEST_FAILED;
    logger.error('部分角色失败，矩阵非全绿');
  }
}
