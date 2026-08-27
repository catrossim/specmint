/**
 * 自定义 Playwright Reporter
 *
 * 该文件被 `playwright.config.ts` 的 `reporter` 字段以模块路径形式加载：
 *   reporter: [['list'], ['./dist/runner/reporter.js']]
 *
 * 默认导出无参构造的 `AutoTestReporter`；运行时依赖通过环境变量注入：
 * - AUTO_TEST_RUN_ID: 当前运行的 ID（由 executor.ts 在 spawn 子进程前写入）
 * - AUTO_TEST_REPORTS_DIR: reports/ 路径（默认 ./reports）
 * - AUTO_TEST_CASES_DIR: tests/ 路径（默认 ./tests）
 *
 * 执行链路（auto-test run → playwright test 子进程）：
 *   1. executor 调用 HistoryStore.createRun 生成 runId
 *   2. spawn 子进程，env 写入上述三个变量
 *   3. 子进程加载本文件，实例化 AutoTestReporter
 *   4. onTestEnd 把每条结果通过 HistoryStore.appendResult 落盘
 *      + 通过 CaseStore.applyRunStats 更新用例 stats
 *   5. onEnd 通过 HistoryStore.finalizeRun 收尾本次运行
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
import { basename } from 'node:path';
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
  const runId = process.env.AUTO_TEST_RUN_ID;
  if (!runId) return null;
  const reportsDir = process.env.AUTO_TEST_REPORTS_DIR ?? './reports';
  const casesDir = process.env.AUTO_TEST_CASES_DIR ?? './tests';
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
        'AUTO_TEST_RUN_ID 未设置，reporter 不会写回历史（可能是非 auto-test run 触发的）',
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
  const caseName = basename(testCase.location.file).replace(/\.spec\.ts$/, '');

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