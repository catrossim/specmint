/**
 * 运行历史存储（HistoryStore）
 *
 * 目录布局：
 *   <reportsDir>/
 *     runs/
 *       <runId>/
 *         run.json
 *         trace.zip            (由 @playwright/test reporter 写出)
 *         test-results/        (失败用例附件，由 Playwright 自动产出)
 *
 * 设计原则：
 * - append-only：createRun 后由 reporter 反复 appendResult，整体重写 run.json
 * - 单进程假设：不做文件锁；如需多进程并发跑回退到 CI 串行或加锁层
 * - runId = ISO 时间戳替换分隔符（人类可读 + 自然排序）
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { CliError, ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type {
  RunConfigSnapshot,
  RunRecord,
  RunStatus,
  RunSummary,
  RunTotals,
  TestResult,
} from './types.js';

export interface HistoryStoreOptions {
  reportsDir?: string;
  cwd?: string;
}

export interface CreateRunInput {
  pattern: string | null;
  /** 触发命令的 argv 字符串 */
  command: string;
  config: RunConfigSnapshot;
  notes?: string;
}

export class HistoryStore {
  private readonly cwd: string;
  private readonly reportsDir: string;

  constructor(options: HistoryStoreOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.reportsDir = resolve(this.cwd, options.reportsDir ?? './reports');
  }

  // --- 路径解析 ---

  runDir(runId: string): string {
    return join(this.reportsDir, 'runs', runId);
  }

  runJsonPath(runId: string): string {
    return join(this.runDir(runId), 'run.json');
  }

  root(): string {
    return this.reportsDir;
  }

  // --- 写入 ---

  /**
   * 创建运行记录。生成 runId + 建目录 + 写初始 run.json。
   */
  createRun(input: CreateRunInput): RunRecord {
    const runId = generateRunId();
    const record: RunRecord = {
      runId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      pattern: input.pattern,
      command: input.command,
      totals: emptyTotals(),
      results: [],
      config: input.config,
      ...(input.notes ? { notes: input.notes } : {}),
    };

    try {
      const dir = this.runDir(runId);
      ensureDir(dir);
      writeFileSync(this.runJsonPath(runId), JSON.stringify(record, null, 2) + '\n', 'utf-8');
    } catch (err) {
      throw new CliError({
        code: ExitCode.IO_ERROR,
        message: `创建运行记录失败：${(err as Error).message}`,
      });
    }
    return record;
  }

  /**
   * 追加单个测试结果。
   * - testId 重复时覆盖（retry 只保留最后一次）
   * - 实现：整体重写 run.json，依赖调用方串行
   */
  appendResult(runId: string, result: TestResult): RunRecord {
    const file = this.runJsonPath(runId);
    if (!existsSync(file)) {
      throw new CliError({
        code: ExitCode.NOT_FOUND,
        message: `运行 ${runId} 不存在`,
      });
    }
    const record = readRecord(file);
    const idx = record.results.findIndex((r) => r.testId === result.testId);
    if (idx >= 0) record.results[idx] = result;
    else record.results.push(result);

    writeRecord(file, record);
    return record;
  }

  /**
   * 完成运行。
   * - 自动计算 totals
   * - 自动 derive status（除非调用方显式传入）
   */
  finalizeRun(
    runId: string,
    patch: { status?: RunStatus; notes?: string } = {},
  ): RunRecord {
    const file = this.runJsonPath(runId);
    if (!existsSync(file)) {
      throw new CliError({
        code: ExitCode.NOT_FOUND,
        message: `运行 ${runId} 不存在`,
      });
    }
    const record = readRecord(file);
    const totals = computeTotals(record.results);
    const next: RunRecord = {
      ...record,
      finishedAt: new Date().toISOString(),
      totals,
      status: patch.status ?? deriveRunStatus(totals),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    };
    writeRecord(file, next);
    return next;
  }

  // --- 读取 ---

  getRun(runId: string): RunRecord | null {
    const file = this.runJsonPath(runId);
    if (!existsSync(file)) return null;
    return readRecord(file);
  }

  /**
   * 列出运行摘要。
   * - 按 startedAt 倒序
   * - run.json 解析失败时跳过并 warning
   */
  listRuns(
    opts: { limit?: number; caseName?: string; status?: RunStatus } = {},
  ): RunSummary[] {
    const baseDir = join(this.reportsDir, 'runs');
    if (!existsSync(baseDir)) return [];

    const dirs = readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const summaries: RunSummary[] = [];
    for (const runId of dirs) {
      const file = this.runJsonPath(runId);
      if (!existsSync(file)) continue;
      let record: RunRecord;
      try {
        record = readRecord(file);
      } catch (err) {
        logger.warn(`解析 ${file} 失败：${(err as Error).message}，跳过`);
        continue;
      }
      if (opts.caseName) {
        const matched = record.results.some((r) => r.caseName === opts.caseName);
        if (!matched) continue;
      }
      if (opts.status && record.status !== opts.status) continue;

      summaries.push(toSummary(record));
    }

    summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (opts.limit) summaries.splice(opts.limit);
    return summaries;
  }

  /**
   * 获取最近一次运行记录。
   * - status 默认会过滤掉 status=running 的进行中记录
   * - 找不到时回退到任意最近一次（便于 debug 未完成运行）
   */
  getLatestRun(opts: { status?: RunStatus; caseName?: string } = {}): RunRecord | null {
    const summaries = this.listRuns({ ...opts, limit: 1 });
    if (summaries.length > 0) {
      return this.getRun(summaries[0]!.runId);
    }
    if (opts.status || opts.caseName) {
      // 已带过滤条件，未命中时不回退
      return null;
    }
    const fallback = this.listRuns({ limit: 1 });
    if (fallback.length === 0) return null;
    return this.getRun(fallback[0]!.runId);
  }

  /**
   * 获取某次运行中失败的用例名（去重）。
   */
  getFailedTestNames(runId: string): string[] {
    const record = this.getRun(runId);
    if (!record) return [];
    const names = new Set<string>();
    for (const r of record.results) {
      if (r.status === 'failed' || r.status === 'timedOut') {
        names.add(r.caseName);
      }
    }
    return Array.from(names);
  }

  /**
   * 获取最近一次运行中失败的用例名。
   * - 优先取 status=failed 的最近一次
   * - 回退到任意最近一次的失败用例
   */
  getLatestFailedTestNames(): string[] {
    const failedLatest = this.getLatestRun({ status: 'failed' });
    if (failedLatest) return this.getFailedTestNames(failedLatest.runId);

    const anyLatest = this.getLatestRun();
    if (!anyLatest) return [];
    return this.getFailedTestNames(anyLatest.runId);
  }
}

// --- helpers ---

function generateRunId(): string {
  // 把 ISO 时间戳的 : . 替换为 -，人类可读且自然排序
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function emptyTotals(): RunTotals {
  return { passed: 0, failed: 0, skipped: 0, timedOut: 0, interrupted: 0, durationMs: 0 };
}

function computeTotals(results: TestResult[]): RunTotals {
  const totals = emptyTotals();
  for (const r of results) {
    totals.durationMs += r.durationMs;
    if (r.status === 'passed') totals.passed++;
    else if (r.status === 'failed') totals.failed++;
    else if (r.status === 'skipped') totals.skipped++;
    else if (r.status === 'timedOut') totals.timedOut++;
    else if (r.status === 'interrupted') totals.interrupted++;
  }
  return totals;
}

function deriveRunStatus(totals: RunTotals): RunStatus {
  if (totals.interrupted > 0) return 'interrupted';
  if (totals.failed > 0 || totals.timedOut > 0) return 'failed';
  return 'passed';
}

function toSummary(record: RunRecord): RunSummary {
  return {
    runId: record.runId,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    status: record.status,
    totals: record.totals,
    failedTests: record.results
      .filter((r) => r.status === 'failed' || r.status === 'timedOut')
      .map((r) => r.testId),
  };
}

function readRecord(file: string): RunRecord {
  return JSON.parse(readFileSync(file, 'utf-8')) as RunRecord;
}

function writeRecord(file: string, record: RunRecord): void {
  try {
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf-8');
  } catch (err) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `写入运行记录失败：${(err as Error).message}`,
    });
  }
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}