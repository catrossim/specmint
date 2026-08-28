/**
 * auth 子命令：管理登录 setup 与 storageState
 *
 * 目录约定（B1 决策）：
 *   .auto-test/auth/<name>.setup.ts
 *   .auto-test/auth/storage/<name>.json
 *
 * 设计要点：
 * - name 强制 kebab-case
 * - storageState 路径由 name 派生
 * - refresh 调用 Playwright --project=auth-setup 单独跑
 * - generate 复用 PI 流程，prompt 强化为"写 setup 文件"
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

const SETUP_FILE_RE = /\.setup\.ts$/;
const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface AuthListOptions { json?: boolean }
export interface AuthInitOptions { json?: boolean }
export interface AuthRefreshOptions { json?: boolean }
export interface AuthGenerateOptions {
  name?: string;
  url?: string;
  json?: boolean;
}

export interface AuthEntry {
  name: string;
  setupPath: string;
  storageStatePath: string;
  hasStorageState: boolean;
}

function ensureAuthDir(): { authDir: string; storageDir: string } {
  const cwd = process.cwd();
  const authDir = join(cwd, STORAGE_LAYOUT.authDir);
  const storageDir = join(cwd, STORAGE_LAYOUT.authStorage);
  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });
  if (!existsSync(storageDir)) mkdirSync(storageDir, { recursive: true });
  return { authDir, storageDir };
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
 * 扫描 .auto-test/auth/*.setup.ts，列出所有 auth 角色。
 */
export function listAuth(cwd: string = process.cwd()): AuthEntry[] {
  const authDir = join(cwd, STORAGE_LAYOUT.authDir);
  if (!existsSync(authDir)) return [];

  const entries: AuthEntry[] = [];
  for (const name of readdirSync(authDir)) {
    if (!SETUP_FILE_RE.test(name)) continue;
    const baseName = name.replace(SETUP_FILE_RE, '');
    const setupPath = join(authDir, name);
    const storageStatePath = join(cwd, STORAGE_LAYOUT.authStorage, `${baseName}.json`);
    entries.push({
      name: baseName,
      setupPath,
      storageStatePath,
      hasStorageState: existsSync(storageStatePath),
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export async function authListCommand(options: AuthListOptions): Promise<void> {
  const entries = listAuth();
  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, count: entries.length, entries }, null, 2) + '\n');
    return;
  }
  if (entries.length === 0) {
    logger.info('当前未配置 auth（.auto-test/auth/ 为空）。用 `auto-test auth init <name>` 创建。');
    return;
  }
  for (const e of entries) {
    const mark = e.hasStorageState ? '✓' : '·';
    process.stdout.write(`  ${mark} ${e.name.padEnd(20)} setup=${e.setupPath}\n`);
    process.stdout.write(`  ${' '.repeat(22)} storage=${e.storageStatePath}\n`);
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
  const storageRel = storageStatePath.replace(cwd + '/', '');
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
  logger.info(`  下一步：编辑该文件填入登录步骤，然后运行 \`auto-test auth refresh ${name}\` 生成 storageState`);
}

/**
 * auth refresh：单独跑 setup 文件刷新 storageState。
 *
 * 实现：spawn \`npx playwright test --config .auto-test/playwright.config.ts --project=auth-setup --grep "<name>"\`
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
      message: `找不到 ${setupPath}，请先运行 \`auto-test auth init ${name}\` 或 auth generate`,
    });
  }
  const { storage } = createStores(cwd);
  const configPath = join(cwd, STORAGE_LAYOUT.configFile);
  if (!existsSync(configPath)) {
    throw new CliError({
      code: ExitCode.NOT_FOUND,
      message: `找不到 ${STORAGE_LAYOUT.configFile}，请先运行 \`auto-test init\``,
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
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(
      'npx',
      ['playwright', 'test', '--config', runnerConfigPath, '--project=auth-setup', '--grep', name],
      { cwd, env, stdio: 'inherit' },
    );
    child.on('exit', (code) => resolve(code ?? 1));
  });

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: exitCode === 0, exitCode }, null, 2) + '\n');
  }
  if (exitCode !== 0) {
    process.exitCode = ExitCode.TEST_FAILED;
    throw new CliError({
      code: ExitCode.TEST_FAILED,
      message: `auth refresh ${name} 失败（exit ${exitCode}）`,
      hint: '检查 setup 文件的登录步骤是否正确',
    });
  }
  logger.info(`✓ storageState 已刷新：${join(cwd, STORAGE_LAYOUT.authStorage, `${name}.json`)}`);
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
    storageStateRel: `.auto-test/auth/storage/${options.name}.json`,
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
  logger.info(`  下一步：运行 \`auto-test auth refresh ${options.name}\` 生成 storageState`);
}