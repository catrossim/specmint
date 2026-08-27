/**
 * 用例库存储（CaseStore）
 *
 * 目录布局：
 *   <casesDir>/
 *     <name>.spec.ts
 *     <name>.meta.json
 *     pages/                          (Page Object 文件，按需)
 *       <name>.page.ts
 *
 * 设计原则：
 * - 同步 fs API 用得足够简单（用例数量级 < 数千），避免引入异步锁
 * - meta.json 解析失败时跳过 + warning，不让单个坏用例阻塞整个 list
 * - 所有写入失败转换为 CliError(IO_ERROR)，便于 CLI 层输出结构化错误
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative as pathRelative, resolve } from 'node:path';
import { CliError, ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type {
  CaseMeta,
  CaseStatus,
  CaseSummary,
  CaseWithCode,
  SelectorPolicy,
} from './types.js';

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 80;

export interface CaseStoreOptions {
  /** 用例库根目录（相对 cwd，默认 ./tests） */
  casesDir?: string;
  /** 工作根，默认 process.cwd() */
  cwd?: string;
}

export interface CaseSaveInput {
  name: string;
  description: string;
  tags?: string[];
  source: {
    type: CaseMeta['source']['type'];
    input: string;
    agentTrace?: string;
  };
  generation: {
    mode: CaseMeta['generation']['mode'];
    model: string;
    exploredUrl: string | null;
    selectorPolicy: SelectorPolicy;
  };
  pageObject?: {
    enabled: boolean;
    /** 相对 casesDir 的 POM 文件路径，如 "./pages/login.page.ts" */
    file?: string;
    code?: string;
  };
}

export interface CaseSaveResult {
  specPath: string;
  metaPath: string;
  pageObjectPath: string | null;
  meta: CaseMeta;
}

export class CaseStore {
  private readonly cwd: string;
  private readonly casesDir: string;

  constructor(options: CaseStoreOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.casesDir = resolve(this.cwd, options.casesDir ?? './tests');
  }

  // --- 路径解析 ---

  specPath(name: string): string {
    return join(this.casesDir, `${name}.spec.ts`);
  }

  metaPath(name: string): string {
    return join(this.casesDir, `${name}.meta.json`);
  }

  pageObjectPath(name: string): string {
    return join(this.casesDir, 'pages', `${name}.page.ts`);
  }

  root(): string {
    return this.casesDir;
  }

  // --- 校验 ---

  private validateName(name: string): void {
    if (!KEBAB_CASE_RE.test(name)) {
      throw new CliError({
        code: ExitCode.USAGE_ERROR,
        message: `用例名必须是 kebab-case：${name}`,
        hint: '只允许小写字母、数字、连字符，且不能以连字符开头或结尾，例如：login-success',
      });
    }
    if (name.length > MAX_NAME_LENGTH) {
      throw new CliError({
        code: ExitCode.USAGE_ERROR,
        message: `用例名过长（${name.length} > ${MAX_NAME_LENGTH}）：${name}`,
      });
    }
  }

  // --- 读取 ---

  exists(name: string): boolean {
    return existsSync(this.specPath(name)) && existsSync(this.metaPath(name));
  }

  /**
   * 列出用例摘要。
   * - 默认按 name 升序
   * - meta.json 缺失或解析失败时跳过并 warning
   * - 支持按 tag 与 name 子串过滤
   */
  list(filter: { tag?: string; pattern?: string } = {}): CaseSummary[] {
    if (!existsSync(this.casesDir)) return [];

    const files = readdirSync(this.casesDir);
    const summaries: CaseSummary[] = [];

    for (const file of files) {
      if (!file.endsWith('.spec.ts')) continue;
      const name = file.slice(0, -'.spec.ts'.length);
      if (filter.pattern && !name.includes(filter.pattern)) continue;

      const metaFile = this.metaPath(name);
      if (!existsSync(metaFile)) {
        logger.warn(`用例 ${name} 缺少 meta.json，跳过`);
        continue;
      }

      let meta: CaseMeta;
      try {
        meta = readMeta(metaFile);
      } catch (err) {
        logger.warn(`解析 ${metaFile} 失败：${(err as Error).message}，跳过`);
        continue;
      }

      if (filter.tag && !meta.tags.includes(filter.tag)) continue;

      const pomRelative = meta.pageObject.enabled && meta.pageObject.file
        ? pathRelative(this.cwd, resolve(this.casesDir, meta.pageObject.file))
        : null;

      summaries.push({
        name,
        description: meta.description,
        tags: meta.tags,
        status: meta.stats.lastStatus,
        lastRunAt: meta.stats.lastRunAt,
        specPath: pathRelative(this.cwd, this.specPath(name)),
        metaPath: pathRelative(this.cwd, this.metaPath(name)),
        pageObjectFile: pomRelative,
      });
    }

    summaries.sort((a, b) => a.name.localeCompare(b.name));
    return summaries;
  }

  get(name: string): CaseMeta | null {
    const metaFile = this.metaPath(name);
    if (!existsSync(metaFile)) return null;
    return readMeta(metaFile);
  }

  readSpec(name: string): string {
    const specFile = this.specPath(name);
    if (!existsSync(specFile)) {
      throw new CliError({
        code: ExitCode.NOT_FOUND,
        message: `用例 ${name} 的 spec.ts 不存在：${specFile}`,
      });
    }
    return readFileSync(specFile, 'utf-8');
  }

  /** 含代码的完整视图（供 agent generate/heal 使用） */
  readWithCode(name: string): CaseWithCode | null {
    const meta = this.get(name);
    if (!meta) return null;
    const code = this.readSpec(name);
    let pageObjectCode: string | undefined;
    if (meta.pageObject.enabled && meta.pageObject.file) {
      const pomFile = resolve(this.casesDir, meta.pageObject.file);
      if (existsSync(pomFile)) pageObjectCode = readFileSync(pomFile, 'utf-8');
    }
    return { ...meta, code, pageObjectCode };
  }

  // --- 写入 ---

  /**
   * 首次保存用例。
   * - 已存在抛 ALREADY_EXISTS；如需覆盖请用 updateCode + updateMeta
   * - 启用 Page Object 时一并写入 POM 文件
   */
  save(input: CaseSaveInput, specCode: string): CaseSaveResult {
    this.validateName(input.name);

    if (this.exists(input.name)) {
      throw new CliError({
        code: ExitCode.ALREADY_EXISTS,
        message: `用例 ${input.name} 已存在`,
        hint: '如需覆盖，请使用 updateCode() 或删除后重新保存',
      });
    }

    ensureDir(this.casesDir);
    const now = new Date().toISOString();
    const meta: CaseMeta = {
      name: input.name,
      description: input.description,
      createdAt: now,
      updatedAt: now,
      tags: dedupe(input.tags ?? []),
      source: {
        type: input.source.type,
        input: input.source.input,
        ...(input.source.agentTrace ? { agentTrace: input.source.agentTrace } : {}),
      },
      generation: input.generation,
      pageObject: {
        enabled: !!input.pageObject?.enabled,
        file: input.pageObject?.file ?? null,
      },
      stats: emptyStats(),
    };

    const specFile = this.specPath(input.name);
    const metaFile = this.metaPath(input.name);
    let pageObjectPathResult: string | null = null;

    try {
      writeFileSync(specFile, specCode, 'utf-8');
      writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

      if (input.pageObject?.enabled && input.pageObject.code && input.pageObject.file) {
        const pomFile = resolve(this.casesDir, input.pageObject.file);
        ensureDir(dirname(pomFile));
        writeFileSync(pomFile, input.pageObject.code, 'utf-8');
        pageObjectPathResult = pomFile;
      }
    } catch (err) {
      // 失败时清理半成品
      if (existsSync(specFile)) safeUnlink(specFile);
      if (existsSync(metaFile)) safeUnlink(metaFile);
      if (pageObjectPathResult && existsSync(pageObjectPathResult)) safeUnlink(pageObjectPathResult);
      throw new CliError({
        code: ExitCode.IO_ERROR,
        message: `保存用例 ${input.name} 失败：${(err as Error).message}`,
      });
    }

    return { specPath: specFile, metaPath: metaFile, pageObjectPath: pageObjectPathResult, meta };
  }

  /**
   * 增量更新 meta（不修改 spec / POM 代码）
   */
  updateMeta(name: string, patch: Partial<Omit<CaseMeta, 'name' | 'createdAt'>>): CaseMeta {
    const current = this.get(name);
    if (!current) {
      throw new CliError({
        code: ExitCode.NOT_FOUND,
        message: `用例 ${name} 不存在`,
      });
    }

    const next: CaseMeta = {
      ...current,
      ...patch,
      name: current.name,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };

    try {
      writeFileSync(this.metaPath(name), JSON.stringify(next, null, 2) + '\n', 'utf-8');
    } catch (err) {
      throw new CliError({
        code: ExitCode.IO_ERROR,
        message: `更新用例 ${name} 的 meta.json 失败：${(err as Error).message}`,
      });
    }
    return next;
  }

  /**
   * 覆盖 spec.ts 与 POM（用于 heal/regenerate 场景）
   */
  updateCode(
    name: string,
    specCode: string,
    pageObject?: { file: string; code: string },
  ): void {
    const meta = this.get(name);
    if (!meta) {
      throw new CliError({
        code: ExitCode.NOT_FOUND,
        message: `用例 ${name} 不存在`,
      });
    }

    try {
      writeFileSync(this.specPath(name), specCode, 'utf-8');
      if (pageObject) {
        const pomFile = resolve(this.casesDir, pageObject.file);
        ensureDir(dirname(pomFile));
        writeFileSync(pomFile, pageObject.code, 'utf-8');
      }
      this.updateMeta(name, {});
    } catch (err) {
      throw new CliError({
        code: ExitCode.IO_ERROR,
        message: `更新用例 ${name} 代码失败：${(err as Error).message}`,
      });
    }
  }

  /**
   * 删除用例（spec + meta + POM）
   */
  delete(name: string): void {
    const meta = this.get(name);
    if (!meta) {
      throw new CliError({
        code: ExitCode.NOT_FOUND,
        message: `用例 ${name} 不存在`,
      });
    }

    const specFile = this.specPath(name);
    const metaFile = this.metaPath(name);
    const pomFile = meta.pageObject.file ? resolve(this.casesDir, meta.pageObject.file) : null;

    try {
      unlinkSync(specFile);
      unlinkSync(metaFile);
      if (pomFile && existsSync(pomFile)) unlinkSync(pomFile);
    } catch (err) {
      throw new CliError({
        code: ExitCode.IO_ERROR,
        message: `删除用例 ${name} 失败：${(err as Error).message}`,
      });
    }
  }

  /**
   * 更新用例的运行统计（runner/reporter 调用）
   *
   * 失败时仅 warning，不抛错（避免 stats 更新错误中断 reporter 流程）。
   */
  applyRunStats(name: string, runId: string, status: CaseStatus, durationMs: number): void {
    const meta = this.get(name);
    if (!meta) {
      logger.warn(`applyRunStats: 用例 ${name} 不存在，跳过`);
      return;
    }
    const prev = meta.stats;
    const newCount = prev.runCount + 1;
    const newAvg =
      prev.runCount === 0
        ? durationMs
        : Math.round((prev.averageDurationMs * prev.runCount + durationMs) / newCount);
    try {
      this.updateMeta(name, {
        stats: {
          runCount: newCount,
          lastStatus: status,
          lastRunAt: new Date().toISOString(),
          lastRunId: runId,
          averageDurationMs: newAvg,
        },
      });
    } catch (err) {
      logger.warn(`更新用例 ${name} 运行统计失败：${(err as Error).message}`);
    }
  }
}

// --- helpers ---

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // 忽略清理失败
  }
}

function readMeta(file: string): CaseMeta {
  const raw = readFileSync(file, 'utf-8');
  return JSON.parse(raw) as CaseMeta;
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function emptyStats(): CaseMeta['stats'] {
  return {
    runCount: 0,
    lastStatus: 'never',
    lastRunAt: null,
    lastRunId: null,
    averageDurationMs: 0,
  };
}