/**
 * rerun 子命令：重跑最近一次失败用例
 *
 * 行为：
 *   - 默认从最近一次 run（无论 status）提取失败用例名集合
 *   - --from <runId> 指定来源 run
 *   - 调用 runTests，pattern 拼接为 "<name>.spec.ts|<name2>.spec.ts"
 *     （playwright CLI 支持以空格分隔多个文件名）
 */
import { runTests } from '../runner/executor.js';
import { loadConfig } from '../config.js';
import { createStores } from '../store/index.js';
import { ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export interface RerunOptions {
  from?: string;
  json?: boolean;
}

export async function rerunCommand(options: RerunOptions): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const { historyStore, storage } = createStores(cwd);

  const failedNames = options.from
    ? historyStore.getFailedTestNames(options.from)
    : historyStore.getLatestFailedTestNames();

  if (failedNames.length === 0) {
    if (options.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, runId: null, message: 'no failed tests', reran: [] }, null, 2) + '\n',
      );
    } else {
      logger.info('没有失败用例可重跑');
    }
    return;
  }

  // playwright CLI pattern：空格分隔多个 spec 文件
  const pattern = failedNames.map((n) => `${n}.spec.ts`).join(' ');

  if (!options.json) {
    logger.info(`重跑 ${failedNames.length} 个用例: ${failedNames.join(', ')}`);
  }

  const result = await runTests({
    pattern,
    cwd,
    casesDir: storage.casesDir,
    reportsDir: storage.reportsDir,
    runnerConfigPath: storage.runnerConfigPath,
    browser: config.runner.defaultBrowser,
  });

  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        { ok: result.exitCode === 0, reran: failedNames, ...result },
        null,
        2,
      ) + '\n',
    );
  }

  if (result.exitCode !== 0) {
    process.exitCode = ExitCode.TEST_FAILED;
  }
}