/**
 * 运行历史存储（HistoryStore）
 *
 * 目录布局：
 *   <reportsDir>/
 *     runs/
 *       <batchId>/
 *         run.json              # specmint 结构化记录
 *         results.json          # Playwright JSON reporter 输出
 *         artifacts/            # Playwright outputDir：screenshots / videos / traces
 *
 * 设计原则：
 * - append-only：createRun 后由 reporter 反复 appendResult，整体重写 run.json
 * - 单进程假设：不做文件锁；如需多进程并发跑回退到 CI 串行或加锁层
 * - batchId 格式：`YYYY-MM-DD_HHMMSS[-<slug>]`，人类可读 + 自然排序
 *   - 默认仅时间戳；同名 slug 由 caller 传入（CLI `--label`）
 *   - 同 batchId 已存在时自动追加 `-2` / `-3` …
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
  /** 运行产物根目录（绝对路径或相对 cwd）。createStores 总会传入。 */
  reportsDir: string;
  /** 工作根，默认 process.cwd() */
  cwd?: string;
}

export interface CreateRunInput {
  pattern: string | null;
  /** 触发命令的 argv 字符串 */
  command: string;
  config: RunConfigSnapshot;
  notes?: string;
  /**
   * 用户友好的批次描述（kebab-case slug）。
   * 会拼到 batchId 末尾，形成 `YYYY-MM-DD_HHMMSS-<slug>`。
   * 由 CLI `--label <slug>` 传入；省略则只用时间戳。
   */
  label?: string;
}

export class HistoryStore {
  private readonly cwd: string;
  private readonly reportsDir: string;

  constructor(options: HistoryStoreOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.reportsDir = resolve(this.cwd, options.reportsDir);
  }

  // --- 路径解析 ---

  runDir(runId: string): string {
    return join(this.reportsDir, 'runs', runId);
  }

  runJsonPath(runId: string): string {
    return join(this.runDir(runId), 'run.json');
  }

  /**
   * Playwright outputDir 路径（screenshots / videos / traces）。
   * 子进程通过 SPECMINT_OUTPUT_DIR 环境变量读取。
   */
  artifactsDir(runId: string): string {
    return join(this.runDir(runId), 'artifacts');
  }

  /**
   * Playwright JSON reporter 输出文件路径。
   * 子进程通过 SPECMINT_JSON_OUTPUT_FILE 环境变量读取。
   */
  jsonReportPath(runId: string): string {
    return join(this.runDir(runId), 'results.json');
  }

  root(): string {
    return this.reportsDir;
  }

  // --- 写入 ---

  /**
   * 创建运行记录。生成 runId + 建目录 + 写初始 run.json。
   *
   * - runId = `YYYY-MM-DD_HHMMSS[-<slug>]`，人类可读 + 自然排序
   * - slug 可选，由 caller 传入（CLI `--label`）
   * - 同 runId 已存在时自动追加 `-2` / `-3` …
   */
  createRun(input: CreateRunInput): RunRecord {
    if (input.label !== undefined) {
      validateLabel(input.label);
    }
    const runId = generateBatchId(this.reportsDir, input.label);
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
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    };

    try {
      const dir = this.runDir(runId);
      ensureDir(dir);
      ensureDir(this.artifactsDir(runId));
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

/**
 * 生成人类友好的批次号（runId）。
 *
 * - 默认格式：`YYYY-MM-DD_HHMMSS`（如 `2026-08-27_150059`），自排序 + shell 安全
 * - 带 label：`YYYY-MM-DD_HHMMSS-<slug>`（如 `2026-08-27_150059-smoke`）
 * - 冲突处理：若 `runs/<id>/` 已存在，追加 `-2`、`-3` …
 */
function generateBatchId(reportsDir: string, label?: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const base =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const candidate = label ? `${base}-${label}` : base;

  const runsDir = join(reportsDir, 'runs');
  if (!existsSync(runsDir)) return candidate;
  if (!existsSync(join(runsDir, candidate))) return candidate;

  // 冲突：追加 -2 / -3 ...
  for (let i = 2; i < 1000; i++) {
    const next = `${candidate}-${i}`;
    if (!existsSync(join(runsDir, next))) return next;
  }
  // 极端兜底：加上毫秒
  return `${candidate}-${d.getMilliseconds()}`;
}

/**
 * 校验 label slug：
 * - kebab-case：`^[a-z0-9]+(?:-[a-z0-9]+)*$`（段间单 `-`，不允许连续 / 收尾 `-`）
 * - 长度 1–32
 * - 合法示例：`smoke` / `p0-regression` / `nightly-batch-2`
 * - 非法示例：`Smoke` / `-smoke` / `smoke-` / `smoke--batch`
 */
export function validateLabel(label: string): void {
  if (typeof label !== 'string' || label.length === 0) {
    throw new CliError({
      code: ExitCode.USAGE_ERROR,
      message: '--label 不能为空',
    });
  }
  if (label.length > 32) {
    throw new CliError({
      code: ExitCode.USAGE_ERROR,
      message: `--label 过长（${label.length} > 32 字符）`,
    });
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label)) {
    throw new CliError({
      code: ExitCode.USAGE_ERROR,
      message: `--label 格式不合法（须为 kebab-case，如 "smoke" / "p0-regression"）：${label}`,
    });
  }
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