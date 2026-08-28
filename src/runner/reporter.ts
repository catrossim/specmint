/**
 * 自定义 Playwright Reporter。
 *
 * `specmint init` 的生成配置内联了同一能力的自包含实现，并通过生成的
 * `specmint-reporter.ts` 入口注册；保留本实现供非 init/包级配置直接复用。
 * 默认导出无参构造的 `AutoTestReporter`；运行时依赖通过环境变量注入：
 * - SPECMINT_RUN_ID: 当前运行的 ID（由 executor.ts 在 spawn 子进程前写入）
 * - SPECMINT_REPORTS_DIR: 当前批次报告目录
 * - SPECMINT_CASES_DIR: tests/ 路径（兜底 .specmint/cases）
 *
 * 兜底策略：env 缺失时使用与主进程一致的默认路径（.specmint/*），
 * 让用户在非 specmint run 触发的场景下也能跑出合理结果，但仍然建议
 * 走 specmint run 以获取正确的 env 注入。
 *
 * 执行链路（specmint run → playwright test 子进程）：
 *   1. executor 调用 HistoryStore.createRun 生成 runId
 *   2. spawn 子进程，env 写入上述变量
 *   3. reporter 实例在 onTestEnd 更新结果与用例 stats
 *   4. onEnd 通过 HistoryStore.finalizeRun 收尾本次运行
 *
 * 设计要点：
 * - `printsToStdio = false`：避免重复打印，让 list reporter 负责用户输出
 * - 单进程内串行调用 appendResult，无并发问题
 */
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult as PWTestResult,
} from '@playwright/test/reporter';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { CaseStore } from '../store/case-store.js';
import { HistoryStore } from '../store/history-store.js';
import type { CaseStatus, RunStatus, TestResult } from '../store/types.js';
import { logger } from '../utils/logger.js';

interface ReporterDeps {
  runId: string;
  historyStore: HistoryStore;
  caseStore: CaseStore;
}

let cachedDeps: ReporterDeps | null = null;

/**
 * 惰性初始化 reporter 依赖。
 * 第一次调用时从环境变量加载；之后缓存。
 */
function resolveDeps(): ReporterDeps | null {
  if (cachedDeps) return cachedDeps;
  const runId = process.env.SPECMINT_RUN_ID;
  if (!runId) return null;
  const reportsDir = process.env.SPECMINT_REPORTS_DIR ?? '.specmint/reports';
  const casesDir = process.env.SPECMINT_CASES_DIR ?? '.specmint/cases';
  cachedDeps = {
    runId,
    historyStore: new HistoryStore({ reportsDir }),
    caseStore: new CaseStore({ casesDir }),
  };
  return cachedDeps;
}

class AutoTestReporter implements Reporter {
  /** 不直接写 stdout/stderr，避免与 list reporter 重复 */
  printsToStdio(): boolean {
    return false;
  }

  onBegin(_config: FullConfig, _suite: Suite): void {
    const deps = resolveDeps();
    if (!deps) {
      logger.warn(
        'SPECMINT_RUN_ID 未设置，reporter 不会写回历史（可能是非 specmint run 触发的）',
      );
    }
  }

  onTestEnd(testCase: TestCase, pwResult: PWTestResult): void {
    const deps = resolveDeps();
    if (!deps) return;

    const result = convertResult(testCase, pwResult);

    try {
      deps.historyStore.appendResult(deps.runId, result);
    } catch (err) {
      logger.warn(`appendResult 失败：${(err as Error).message}`);
    }

    try {
      deps.caseStore.applyRunStats(
        result.caseName,
        deps.runId,
        result.status,
        result.durationMs,
      );
    } catch (err) {
      logger.warn(`applyRunStats 失败：${(err as Error).message}`);
    }
  }

  onEnd(result: FullResult): void {
    const deps = resolveDeps();
    if (!deps) return;
    try {
      deps.historyStore.finalizeRun(deps.runId, { status: mapRunStatus(result.status) });
    } catch (err) {
      logger.warn(`finalizeRun 失败：${(err as Error).message}`);
    }
  }

  onError(error: TestError): void {
    logger.error(`reporter.onError: ${error.message ?? 'unknown error'}`);
  }
}

// --- helpers ---

function convertResult(testCase: TestCase, pw: PWTestResult): TestResult {
  // 规范化 caseName 为「组/名称」形式（相对 cases 目录），与 CLI 参数保持一致；
  // cases 目录之外的文件（如 auth/*.setup.ts）退化为文件基名
  const casesDir = resolve(process.env.SPECMINT_CASES_DIR ?? '.specmint/cases');
  const file = resolve(testCase.location.file);
  const rel = relative(casesDir, file).replace(/\.spec\.ts$/, '');
  const caseName =
    !rel.startsWith('..') && !isAbsolute(rel)
      ? rel.split(sep).join('/')
      : basename(file).replace(/\.spec\.ts$/, '');

  const attachments = (pw.attachments ?? []).map((a) => ({
    name: a.name ?? 'unnamed',
    path: a.path ?? '',
    contentType: a.contentType ?? 'application/octet-stream',
  }));

  // pw.startTime 通常是 Date，但 SDK 跨版本可能差异，防御性转换
  const startMs =
    pw.startTime instanceof Date
      ? pw.startTime.getTime()
      : new Date(pw.startTime as unknown as number | string).getTime();
  const startedAt = new Date(startMs).toISOString();
  const finishedAt = new Date(startMs + pw.duration).toISOString();

  return {
    testId: `${testCase.location.file}::${testCase.titlePath().join(' > ')}`,
    title: testCase.title,
    caseName,
    status: mapCaseStatus(pw.status),
    durationMs: pw.duration,
    retry: pw.retry,
    ...(pw.error
      ? {
          error: {
            message: pw.error.message ?? '',
            ...(pw.error.stack ? { stack: pw.error.stack } : {}),
          },
        }
      : {}),
    attachments,
    startedAt,
    finishedAt,
  };
}

function mapCaseStatus(s: PWTestResult['status']): CaseStatus {
  switch (s) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'timedOut':
      return 'timedOut';
    case 'skipped':
      return 'skipped';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'failed';
  }
}

function mapRunStatus(s: FullResult['status']): RunStatus {
  switch (s) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'timedout':
      return 'timedOut';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'error';
  }
}

export default AutoTestReporter;