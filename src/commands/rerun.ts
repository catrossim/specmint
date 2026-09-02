/**
 * rerun 子命令：重跑最近一次失败用例
 *
 * 行为：
 *   - 默认从最近一次 run 提取失败用例名集合
 *   - --from <runId> 指定来源 run
 *   - 把失败名转换为 Playwright patterns：["<name>.spec.ts", "<name2>.spec.ts", ...]（多个 positional args）
 *
 * P1 verdict 卡口（与 run 共用同一套过滤规则）：
 *   - 预筛 failedNames，按 config.review.blockedOnRun 减去 --include-* 解禁项
 *   - 全部被过滤时给出清晰提示，--include-* / --force / --no-require-review 可放宽
 */
import { runTests } from '../runner/executor.js';
import { loadConfig } from '../config.js';
import { createStores } from '../store/index.js';
import { ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { ReviewVerdict } from '../store/types.js';

export interface RerunOptions {
  from?: string;
  json?: boolean;
  includePending?: boolean;
  includeNeedsFix?: boolean;
  includeRejected?: boolean;
  force?: boolean;
  noRequireReview?: boolean;
}

export async function rerunCommand(options: RerunOptions): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const { historyStore, caseStore, storage } = createStores(cwd);

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

  // P1：verdict 卡口预筛
  const reviewCfg = config.review;
  const gateEnabled =
    !!reviewCfg?.requireBeforeRun && !options.noRequireReview && !options.force;

  let toRerun: string[] = failedNames;
  let skipped: Array<{ name: string; verdict: ReviewVerdict }> = [];

  if (gateEnabled) {
    const blockedSet = new Set<ReviewVerdict>(reviewCfg!.blockedOnRun);
    if (options.includePending) blockedSet.delete('pending');
    if (options.includeNeedsFix) blockedSet.delete('needs-fix');
    if (options.includeRejected) blockedSet.delete('rejected');

    const allByName = new Map(caseStore.list({}).map((m) => [m.name, m]));
    toRerun = [];
    skipped = [];
    for (const name of failedNames) {
      const m = allByName.get(name);
      const verdict = (m?.reviewVerdict ?? 'pending') as ReviewVerdict;
      if (blockedSet.has(verdict)) skipped.push({ name, verdict });
      else toRerun.push(name);
    }

    if (toRerun.length === 0) {
      const verdicts = Array.from(new Set(skipped.map((s) => s.verdict)));
      logger.warn(
        `[review gate] ${failedNames.length} 个失败用例全部被 verdict 过滤跳过（verdicts: ${verdicts.join(', ')}）`,
      );
      logger.warn(`  用 --include-pending / --include-needs-fix / --include-rejected 放宽`);
      process.exitCode = ExitCode.NOT_FOUND;
      return;
    }
    if (skipped.length > 0 && !options.json) {
      const preview = skipped
        .slice(0, 5)
        .map((s) => `${s.name}=${s.verdict}`)
        .join(', ');
      logger.warn(
        `[review gate] 跳过 ${skipped.length} 个失败用例（verdict 被过滤）：${preview}${skipped.length > 5 ? ' ...' : ''}`,
      );
    }
  }

  if (!options.json) {
    logger.info(`重跑 ${toRerun.length} 个用例: ${toRerun.join(', ')}`);
  }

  const result = await runTests({
    // 多个 positional args（每个是文件路径正则），不要用空格 join 成单个 pattern：
    // JS 里 join(' ') 得到的是单个 argv 元素（含空格的字符串），Playwright 会把它当成
    // 一个"路径中带空格"的正则去匹配，永远命不中任何文件 → "No tests found"。
    // shell 里空格分隔多文件是 shell 展开成多个 argv 的行为，spawn 直传时必须用数组。
    patterns: toRerun.map((n) => `${n}.spec.ts`),
    cwd,
    casesDir: storage.casesDir,
    reportsDir: storage.reportsDir,
    configPath: storage.configPath,
    authDir: storage.authDir,
    config,
    browser: config.runner.defaultBrowser,
  });

  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: result.exitCode === 0,
          reran: toRerun,
          skipped: skipped.map((s) => `${s.name}=${s.verdict}`),
          ...result,
        },
        null,
        2,
      ) + '\n',
    );
  }

  if (result.exitCode !== 0) {
    process.exitCode = ExitCode.TEST_FAILED;
  }
}
