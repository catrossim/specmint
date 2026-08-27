/**
 * run 子命令：运行用例
 *
 * 透传所有 runner 选项；底层调用 runTests（spawn playwright test + reporter 写盘）
 */
import { runTests } from '../runner/executor.js';
import { loadConfig } from '../config.js';
import { ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface RunOptions {
  browser?: string;
  headed?: boolean;
  ui?: boolean;
  debug?: boolean;
  workers?: string;
  retries?: string;
  grep?: string;
  json?: boolean;
}

export async function runCommand(
  pattern: string | undefined,
  options: RunOptions,
): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);

  const workers = options.workers !== undefined ? parseInt(options.workers, 10) : undefined;
  const retries = options.retries !== undefined ? parseInt(options.retries, 10) : undefined;

  // 把 kebab-case 用例名转成 spec.ts 文件路径，避免被 Playwright 当作 project 名
  const resolvedPattern = pattern
    ? pattern.includes('/') || pattern.endsWith('.ts')
      ? pattern
      : `tests/${pattern}.spec.ts`
    : undefined;

  const result = await runTests({
    pattern: resolvedPattern,
    browser: options.browser ?? config.runner.defaultBrowser,
    headed: options.headed,
    ui: options.ui,
    debug: options.debug,
    workers: Number.isFinite(workers) ? workers : undefined,
    retries: Number.isFinite(retries) ? retries : undefined,
    grep: options.grep,
    configPath: config.runner.configPath,
    cwd,
    casesDir: config.storage.casesDir,
    reportsDir: config.storage.reportsDir,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: result.exitCode === 0, ...result }, null, 2) + '\n');
  } else {
    logger.info(`runId: ${result.runId}`);
    logger.info(`status: ${result.status}`);
    logger.info(`exitCode: ${result.exitCode}`);
  }

  // 退出码语义：测试失败 → ExitCode.TEST_FAILED
  if (result.exitCode !== 0) {
    process.exitCode = ExitCode.TEST_FAILED;
  }
}