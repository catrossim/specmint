import { runTests } from '../runner/executor.js';
import { loadConfig } from '../config.js';
import { createStores } from '../store/index.js';
import { ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { relative as pathRelative, resolve as pathResolve } from 'node:path';
import type { Priority, ReviewVerdict } from '../store/types.js';

export interface RunOptions {
  browser?: string;
  headed?: boolean;
  ui?: boolean;
  debug?: boolean;
  workers?: string;
  retries?: string;
  grep?: string;
  priority?: Priority[];
  header?: string[];
  storageState?: string;
  /** CLI --auth <name> */
  authName?: string;
  /** CLI --no-auth */
  noAuth?: boolean;
  /** CLI --config <path>：显式指定自定义 Playwright 配置（默认走包内） */
  configPath?: string;
  json?: boolean;
  /** CLI --label <slug>：批次语义标签 */
  label?: string;
  /** P1：review verdict 卡口标志（与 config.review 段叠加生效） */
  includePending?: boolean;
  includeNeedsFix?: boolean;
  includeRejected?: boolean;
  /** 强制跳过 verdict 检查；单条用例生效时也关闭 warning */
  force?: boolean;
  /** 关闭 verdict 卡口（等价 requireBeforeRun=false） */
  noRequireReview?: boolean;
}

export async function runCommand(
  pattern: string | undefined,
  options: RunOptions,
): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const { caseStore, storage } = createStores(cwd);

  const workers = options.workers !== undefined ? parseInt(options.workers, 10) : undefined;
  const retries = options.retries !== undefined ? parseInt(options.retries, 10) : undefined;

  // P1：verdict 卡口预处理（计算 blocked 集合）
  const reviewCfg = config.review;
  const gateEnabled =
    !!reviewCfg?.requireBeforeRun && !options.noRequireReview && !options.force;
  const blockedSet = new Set<ReviewVerdict>();
  if (gateEnabled) {
    for (const v of reviewCfg!.blockedOnRun) blockedSet.add(v);
    if (options.includePending) blockedSet.delete('pending');
    if (options.includeNeedsFix) blockedSet.delete('needs-fix');
    if (options.includeRejected) blockedSet.delete('rejected');
  }

  let resolvedPattern: string | undefined;
  if (pattern) {
    if (pattern.includes('/') || pattern.endsWith('.ts')) {
      resolvedPattern = pattern;
    } else {
      const rawMatches = caseStore.list({ pattern });
      const matches = gateEnabled
        ? rawMatches.filter(
            (m) => !blockedSet.has((m.reviewVerdict ?? 'pending') as ReviewVerdict),
          )
        : rawMatches;
      if (matches.length === 0) {
        if (gateEnabled && rawMatches.length > 0) {
          const verdicts = Array.from(
            new Set(rawMatches.map((m) => m.reviewVerdict ?? 'pending')),
          );
          logger.warn(
            `[review gate] 与 "${pattern}" 匹配的 ${rawMatches.length} 条用例全部被 verdict 过滤跳过（verdicts: ${verdicts.join(', ')}）`,
          );
          logger.warn(
            `  用 --include-pending / --include-needs-fix / --include-rejected 放宽过滤，或 --force 关闭卡口`,
          );
          process.exitCode = ExitCode.NOT_FOUND;
          return;
        }
        logger.warn(`未找到与 "${pattern}" 匹配的用例`);
        process.exitCode = ExitCode.NOT_FOUND;
        return;
      }
      if (matches.length === 1) {
        const match = matches[0]!;
        resolvedPattern = pathRelative(
          cwd,
          pathResolve(storage.casesDir, `${match.name}.spec.ts`),
        );
      } else {
        resolvedPattern = undefined;
        options.grep = options.grep ?? matches.map((m) => m.name).join('|');
      }
    }
  }

  // 优先级 / auth 过滤（在 verdict 过滤前完成，确保 options.grep 派生自最终候选集）
  if (options.priority && options.priority.length > 0 && !options.grep && !pattern) {
    const items = caseStore.list({ priority: options.priority });
    if (items.length === 0) {
      logger.warn(`没有匹配 priority=${options.priority.join(',')} 的用例`);
      process.exitCode = ExitCode.NOT_FOUND;
      return;
    }
    options.grep = items.map((m) => m.name).join('|');
  }

  if (options.authName && !options.grep && !pattern) {
    const items = caseStore.list({ auth: options.authName });
    if (items.length === 0) {
      logger.warn(`没有匹配 auth=${options.authName} 的用例`);
      process.exitCode = ExitCode.NOT_FOUND;
      return;
    }
    options.grep = items.map((m) => m.name).join('|');
  }
  if (options.authName && !options.storageState && !options.noAuth) {
    options.storageState = `.specmint/auth/storage/${options.authName}.json`;
  }

  // P1：options.grep 派生场景下的 verdict 过滤
  if (gateEnabled && options.grep) {
    const names = options.grep.split('|').filter(Boolean);
    const allByName = new Map(caseStore.list({}).map((m) => [m.name, m]));
    const skipped: Array<{ name: string; verdict: ReviewVerdict }> = [];
    const kept: string[] = [];
    for (const name of names) {
      const m = allByName.get(name);
      const verdict = (m?.reviewVerdict ?? 'pending') as ReviewVerdict;
      if (blockedSet.has(verdict)) skipped.push({ name, verdict });
      else kept.push(name);
    }
    if (kept.length === 0) {
      const verdicts = Array.from(new Set(skipped.map((s) => s.verdict)));
      logger.warn(
        `[review gate] ${names.length} 条候选用例全部被 verdict 过滤跳过（verdicts: ${verdicts.join(', ')}）`,
      );
      logger.warn(`  用 --include-pending / --include-needs-fix / --include-rejected 放宽`);
      process.exitCode = ExitCode.NOT_FOUND;
      return;
    }
    options.grep = kept.join('|');
    if (skipped.length > 0 && !options.json) {
      const preview = skipped
        .slice(0, 5)
        .map((s) => `${s.name}=${s.verdict}`)
        .join(', ');
      logger.warn(
        `[review gate] 跳过 ${skipped.length} 条（verdict 被过滤）：${preview}${skipped.length > 5 ? ' ...' : ''}`,
      );
    }
  }

  // P1：单文件模式（resolvedPattern 直接指定文件路径），按 specPath 查 verdict
  if (gateEnabled && resolvedPattern && !options.grep) {
    const candidates = caseStore.list({});
    const matchCandidate = candidates.find((m) => {
      const rel = pathRelative(cwd, pathResolve(cwd, m.specPath));
      return rel === resolvedPattern || m.specPath === resolvedPattern;
    });
    if (matchCandidate) {
      const verdict = (matchCandidate.reviewVerdict ?? 'pending') as ReviewVerdict;
      if (blockedSet.has(verdict)) {
        logger.warn(
          `[review gate] 用例 ${matchCandidate.name} 当前 verdict=${verdict}，已被 config.review.blockedOnRun 过滤。用 --include-* 或 --force 覆盖。`,
        );
        process.exitCode = ExitCode.NOT_FOUND;
        return;
      }
      if (verdict !== 'approved' && !options.json) {
        logger.warn(
          `[run] ${matchCandidate.name} verdict=${verdict}（非 approved 但已通过过滤，仍执行；建议尽快标 approved 或 needs-fix）`,
        );
      }
    }
  }

  const result = await runTests({
    pattern: resolvedPattern,
    browser: options.browser ?? config.runner.defaultBrowser,
    headed: options.headed,
    ui: options.ui,
    debug: options.debug,
    workers: Number.isFinite(workers) ? workers : undefined,
    retries: Number.isFinite(retries) ? retries : undefined,
    grep: options.grep,
    runnerConfigPath: options.configPath,
    cwd,
    casesDir: storage.casesDir,
    reportsDir: storage.reportsDir,
    configPath: storage.configPath,
    authDir: storage.authDir,
    config,
    auth: {
      headers: options.header && options.header.length > 0 ? options.header : undefined,
      storageState: options.storageState,
      noAuth: options.noAuth === true,
    },
    label: options.label,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: result.exitCode === 0, ...result }, null, 2) + '\n');
  } else {
    logger.info(`runId: ${result.runId}`);
    logger.info(`status: ${result.status}`);
    logger.info(`exitCode: ${result.exitCode}`);
  }

  if (result.exitCode !== 0) {
    process.exitCode = ExitCode.TEST_FAILED;
  }
}
