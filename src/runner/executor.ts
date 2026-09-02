/**
 * 运行器（executor）
 *
 * 设计原则：
 * - 不重新实现并行调度 / retry / trace，直接复用 `npx playwright test` 官方 CLI
 * - 批次环境变量（路径、鉴权、baseURL、浏览器通道）由 spawn-env.buildSpawnEnv 统一注入
 * - 历史记录由 reporter 在子进程中写盘；executor 仅负责 createRun + 进程编排 + 兜底
 *
 * 兜底机制：
 * - 如果 reporter.onEnd 没机会执行（如子进程被 SIGKILL），run.json 仍可能是 status=running
 * - executor 退出前会检查并自动 finalize 为 status=error，确保 history 不留死链
 *
 * 配置定位：
 * - 默认走 resolveRunnerConfigPath() —— 包内 dist/runner/playwright.config.{js,ts}
 * - CLI --config 透传时显式覆盖
 *
 * 子进程启动：
 * - 走 spawn-playwright.ts 统一助手（createRequire 直连用户项目 playwright CLI，
 *   win32 兼容性 + 路径空格安全），不直接 spawn npx
 */
import { resolveRunnerConfigPath } from './config-resolver.js';
import { buildSpawnEnv } from './spawn-env.js';
import { spawnPlaywrightTest, type PlaywrightSpawnResult } from './spawn-playwright.js';
import { HistoryStore } from '../store/history-store.js';
import type { AutoTestConfig } from '../config.js';
import type { RunConfigSnapshot, RunStatus } from '../store/types.js';
import { logger } from '../utils/logger.js';

export interface RunOptions {
  /**
   * 单文件路径（Playwright positional arg，匹配文件路径）。仅当 cases 列表收敛到 1 个时使用。
   * 多文件请用 `patterns: string[]`。
   */
  pattern?: string;
  /**
   * 多文件路径列表（Playwright 多个 positional args，每个都是文件路径正则）。
   *
   * 为什么用 positional arg 而不是 `--grep`：
   * - `--grep` 只匹配测试的 full title（`<describe> > <test>` 拼接），
   *   而 spec.ts 里的标题是人类可读的中文场景名（`用户认证 · 登录流程 > 合法凭据登录成功并跳转首页`），
   *   不是 case 内部名（kebab-case，如 `auth/login-success`），所以传 case 名做 grep 永远匹配不到。
   * - positional arg 是按文件路径正则匹配 spec.ts 文件名，case 内部名 → spec 文件路径
   *   的映射是一一对应的（`<casesDir>/<name>.spec.ts`），所以用它做"按 case 名筛选"是稳的。
   */
  patterns?: string[];
  browser?: string;
  headed?: boolean;
  ui?: boolean;
  debug?: boolean;
  workers?: number;
  retries?: number;
  grep?: string;
  /** CLI --config <path> 显式覆盖；省略则走默认包内配置。 */
  runnerConfigPath?: string;
  maxFailures?: number;
  cwd?: string;
  casesDir: string;
  reportsDir: string;
  /** config.json 绝对路径（SPECMINT_CONFIG_PATH 注入包内配置）。 */
  configPath: string;
  /** .specmint/auth/ 绝对路径（SPECMINT_AUTH_DIR 注入包内配置）。 */
  authDir: string;
  /** 已读取的 config.json 内容（spawn-env 据此决策浏览器通道等）。 */
  config: AutoTestConfig;
  /** 透传给 playwright test 的额外参数（高级选项） */
  passthrough?: string[];
  /**
   * 鉴权注入（阶段 1）：
   * - headers：可多次传 "K=V" 形式，转成 SPECMINT_HEADER_<KEY>=V env
   * - storageState：覆盖 config.auth.storageState（→ SPECMINT_STORAGE_STATE env）
   * - noAuth：跳过 storageState（→ SPECMINT_NO_AUTH=1）
   */
  auth?: {
    headers?: string[];
    storageState?: string;
    noAuth?: boolean;
  };
  /**
   * 批次语义标签（kebab-case slug）。
   * 会拼到 runId 末尾：`YYYY-MM-DD_HHMMSS-<slug>`，便于人工识别。
   */
  label?: string;
}

export interface RunResult {
  runId: string;
  exitCode: number;
  status: RunStatus;
  durationMs: number;
  command: string;
  startedAt: string;
}

export async function runTests(options: RunOptions): Promise<RunResult> {
  const cwd = options.cwd ?? process.cwd();
  const runnerConfigPath = resolveRunnerConfigPath(options.runnerConfigPath);

  const historyStore = new HistoryStore({ cwd, reportsDir: options.reportsDir });

  const snapshot: RunConfigSnapshot = {
    configPath: runnerConfigPath,
    baseURL: process.env.SPECMINT_BASE_URL ?? null,
    retries: options.retries ?? (process.env.CI ? 2 : 1),
    workers: options.workers ?? (process.env.CI ? 1 : undefined) ?? 1,
    browser: options.browser ?? 'chromium',
  };

  const commandArgv = process.argv.slice(2).join(' ');
  const record = historyStore.createRun({
    pattern: options.pattern ?? null,
    command: commandArgv,
    config: snapshot,
    label: options.label,
  });

  logger.info(`run ${record.runId} 开始`);
  logger.info(`reports: ${historyStore.runDir(record.runId)}`);

  const args = buildPlaywrightArgs({ ...options, runnerConfigPath });
  const start = Date.now();

  const { env } = buildSpawnEnv({
    cwd,
    casesDir: options.casesDir,
    reportsDir: options.reportsDir,
    authDir: options.authDir,
    configPath: options.configPath,
    runId: record.runId,
    outputDir: historyStore.artifactsDir(record.runId),
    jsonOutputFile: historyStore.jsonReportPath(record.runId),
    auth: options.auth,
    config: options.config,
  });

  let spawnResult: PlaywrightSpawnResult;
  try {
    spawnResult = await spawnPlaywrightTest(args, { cwd, env });
  } catch (err) {
    historyStore.finalizeRun(record.runId, {
      status: 'error',
      notes: `executor error: ${(err as Error).message}`,
    });
    throw err;
  }

  const durationMs = Date.now() - start;

  let finalStatus: RunStatus = spawnResult.exitCode === 0 ? 'passed' : 'failed';
  const finalRecord = historyStore.getRun(record.runId);
  if (finalRecord && finalRecord.status === 'running') {
    historyStore.finalizeRun(record.runId, {
      status: spawnResult.exitCode === 0 ? 'passed' : 'error',
      notes: spawnResult.signal
        ? `executor 兜底：子进程被 ${spawnResult.signal} 终止`
        : `executor 兜底：reporter 未 finalize，exit=${spawnResult.exitCode}`,
    });
    const updated = historyStore.getRun(record.runId);
    if (updated) finalStatus = updated.status;
  } else if (finalRecord) {
    finalStatus = finalRecord.status;
  }

  logger.info(
    `run ${record.runId} 结束，状态 ${finalStatus}，退出码 ${spawnResult.exitCode}，耗时 ${durationMs}ms`,
  );

  return {
    runId: record.runId,
    exitCode: spawnResult.exitCode,
    status: finalStatus,
    durationMs,
    command: spawnResult.command,
    startedAt: record.startedAt,
  };
}

function buildPlaywrightArgs(options: RunOptions & { runnerConfigPath: string }): string[] {
  // 注意：返回的 args 是 `playwright test` 之后的参数列表（不含 'playwright' / 'test' 前缀）
  // 由 spawn-playwright.ts 助手负责把前缀接上，并直连 cli.js / 回退 npx
  const args: string[] = ['--config', options.runnerConfigPath];
  if (options.workers !== undefined) args.push('--workers', String(options.workers));
  if (options.retries !== undefined) args.push('--retries', String(options.retries));
  if (options.maxFailures !== undefined) args.push('--max-failures', String(options.maxFailures));
  if (options.browser) args.push(`--project=${options.browser}`);
  if (options.headed) args.push('--headed');
  if (options.ui) args.push('--ui');
  if (options.debug) args.push('--debug');
  if (options.grep) args.push('--grep', options.grep);
  // pattern 与 patterns 并存防御：positional args 叠加是"取并集"，会让执行集大于调用方预期
  // （调用方往往只想二选一）。这里 patterns 优先、忽略 pattern，避免静默扩大执行范围。
  if (options.patterns && options.patterns.length > 0) {
    if (options.pattern) {
      logger.warn(
        '[executor] pattern 与 patterns 同时传入，已忽略 pattern（positional args 并集会扩大执行集）',
      );
    }
    args.push(...options.patterns);
  } else if (options.pattern) {
    args.push(options.pattern);
  }
  if (options.passthrough) args.push(...options.passthrough);
  return args;
}