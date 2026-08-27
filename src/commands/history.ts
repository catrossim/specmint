/**
 * history 子命令：查看运行历史
 */
import { createStores } from '../store/index.js';
import { loadConfig } from '../config.js';
import { logger } from '../utils/logger.js';

export interface HistoryOptions {
  limit?: string;
  case?: string;
  json?: boolean;
}

export async function historyCommand(options: HistoryOptions): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const { historyStore } = createStores(cwd);

  const limit = options.limit ? parseInt(options.limit, 10) : 10;
  const summaries = historyStore.listRuns({
    limit: Number.isFinite(limit) ? limit : 10,
    ...(options.case ? { caseName: options.case } : {}),
  });

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, count: summaries.length, items: summaries }, null, 2) + '\n');
    return;
  }

  if (summaries.length === 0) {
    logger.info('没有运行记录');
    return;
  }

  for (const s of summaries) {
    process.stdout.write(`${s.runId}  [${s.status}]\n`);
    process.stdout.write(
      `  started: ${s.startedAt}  finished: ${s.finishedAt ?? '(running)'}\n`,
    );
    process.stdout.write(
      `  totals: passed=${s.totals.passed} failed=${s.totals.failed} skipped=${s.totals.skipped} interrupted=${s.totals.interrupted} (${s.totals.durationMs}ms)\n`,
    );
    if (s.failedTests.length > 0) {
      process.stdout.write(`  failed: ${s.failedTests.join(', ')}\n`);
    }
  }
}