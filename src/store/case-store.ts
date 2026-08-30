/**
 * 用例库存储（CaseStore）
 *
 * 目录布局：
 *   <casesDir>/
 *     <name>.spec.ts
 *     <name>.meta.json
 *     <pageObjectsDir>/                  (Page Object 文件，按需)
 *       <name>.page.ts
 *
 * 设计原则：
 * - 同步 fs API 用得足够简单（用例数量级 < 数千），避免引入异步锁
 * - meta.json 解析失败时跳过 + warning，不让单个坏用例阻塞整个 list
 * - 所有写入失败转换为 CliError(IO_ERROR)，便于 CLI 层输出结构化错误
 * - 路径必须从外部（createStores）传入，不再有 './tests' 兜底
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative as pathRelative, resolve } from 'node:path';
import { CliError, ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { normalizeCaseMeta, normalizeTags } from '../utils/normalize-meta.js';
import { throwIfInvalid } from '../utils/case-schema.js';
import type {
  CaseMeta,
  CaseStatus,
  CaseSummary,
  CaseWithCode,
  Priority,
  ReviewState,
  SelectorPolicy,
} from './types.js';

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 80;

/**
 * 匹配 `import ... from "<path>"` 或 `export ... from "<path>"`，
 * 注意只取首个引号串形式的 from 子句；副作用 import（无 from）不在内。
 */
const SPEC_IMPORT_FROM_RE = /((?:^|\n)\s*(?:import|export)\s+(?:[^'"\n;]+?\s+from\s+)?)(['"])([^'"\n]+?)\2/g;

/**
 * 对 spec.ts 源码做「POM 导入路径规范化」。
 *
 * 背景：POM 物理位置在 <casesDir>/pages/<sub>.page.ts，而 spec.ts 位于
 * <casesDir>/<group>/<sub>.spec.ts（在 group 子目录下），因此 import 必须写
 * 相对 spec.ts 自身目录的路径，并强制带 `.ts` 后缀（ESM 模式下 Node 强制要求）。
 *
 * LLM 经常写错，如 `./pages/<sub>.page` 或省略扩展名。本函数做兜底：
 * - 扫描所有 `import/export ... from '...'` 中的相对路径；
 * - 解析为绝对路径后，若与 POM 路径（去扩展名）一致，则统一改写为
 *   「相对 specDir + 带 .ts 后缀」的规范路径；
 * - 其余非 POM 的第三方/工具 import 完全不动。
 *
 * @returns 改写后的源代码与是否发生过重写
 */
function rewriteSpecImports(
  specCode: string,
  specDirAbs: string,
  pomAbsoluteFile: string,
): { code: string; changed: boolean } {
  const pomNoExt = pomAbsoluteFile.replace(/\.[A-Za-z]+$/, '');
  const desiredRel = pathRelative(specDirAbs, pomAbsoluteFile).replace(/\\/g, '/');
  let changed = false;

  const replaced = specCode.replace(
    SPEC_IMPORT_FROM_RE,
    (m: string, head: string, quote: string, p: string): string => {
      if (!p) return m;
      if (!(p.startsWith('.') || p.startsWith('/'))) return m;
      const abs = isAbsolute(p) ? p : resolve(specDirAbs, p);
      const absNoExt = abs.replace(/\.[A-Za-z]+$/, '');
      if (absNoExt !== pomNoExt) return m;
      changed = true;
      return `${head}${quote}${desiredRel}${quote}`;
    },
  );

  return { code: replaced, changed };
}

export interface CaseStoreOptions {
  /** 用例库根目录（绝对路径或相对 cwd）。createStores 总会传入。 */
  casesDir: string;
  /** Page Object 目录（绝对路径或相对 cwd）。默认 <casesDir>/pages。 */
  pageObjectsDir?: string;
  /** 工作根，默认 process.cwd() */
  cwd?: string;
}

export interface CaseSaveInput {
  name: string;
  description: string;
  /** 必填语义：generate 命令会强制传入，save 时若缺失会抛错。 */
  priority?: Priority;
  group?: string;
  module?: string;
  linkedTickets?: string[];
  /** 阶段 2：关联 auth 角色（kebab-case）。可选。 */
  auth?: string;
  tags?: string[];
  source: {
    type: CaseMeta['source']['type'];
    input: string;
    agentTrace?: string;
  };
  generation: {
    mode: CaseMeta['generation']['mode'];
    model?: string;
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
  private readonly pageObjectsDir: string;

  constructor(options: CaseStoreOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.casesDir = resolve(this.cwd, options.casesDir);
    this.pageObjectsDir = options.pageObjectsDir
      ? resolve(this.cwd, options.pageObjectsDir)
      : join(this.casesDir, 'pages');
  }

  // --- 路径解析 ---

  specPath(name: string): string {
    return join(this.casesDir, `${name}.spec.ts`);
  }

  metaPath(name: string): string {
    return join(this.casesDir, `${name}.meta.json`);
  }

  pageObjectPath(name: string): string {
    return join(this.pageObjectsDir, `${name}.page.ts`);
  }

  root(): string {
    return this.casesDir;
  }

  // --- 校验 ---

  private validateName(name: string): void {
    // 允许 "<group>/<kebab-case>" 形式，每段都必须是 kebab-case
    const GROUPED_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/;
    if (!GROUPED_NAME_RE.test(name)) {
      throw new CliError({
        code: ExitCode.USAGE_ERROR,
        message: `用例名格式不合法：${name}`,
        hint: '只允许小写字母、数字、连字符；按功能模块分组时用 "<group>/<name>" 形式，例如：auth/login-success',
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
   * - 递归扫描 casesDir 下所有子目录，支持按 group（功能模块）分目录
   * - meta.json 缺失或解析失败时跳过并 warning
   * - 支持按 tag、name 子串、priority（单个或数组）、auth、module、group 过滤
   */
  list(
    filter: {
      tag?: string;
      pattern?: string;
      priority?: Priority | Priority[];
      auth?: string;
      module?: string;
      group?: string;
    } = {},
  ): CaseSummary[] {
    if (!existsSync(this.casesDir)) return [];

    const priorityFilter: ReadonlySet<Priority> | null = Array.isArray(filter.priority)
      ? new Set(filter.priority as Priority[])
      : filter.priority
        ? new Set([filter.priority])
        : null;

    // 递归收集所有 .spec.ts 文件路径
    const specFiles = collectSpecFiles(this.casesDir);
    const summaries: CaseSummary[] = [];

    for (const specFile of specFiles) {
      // 从 casesDir 推导 name（含 group 前缀），例如 auth/login-success
      const rel = pathRelative(this.casesDir, specFile).replace(/\\/g, '/');
      if (!rel.endsWith('.spec.ts')) continue;
      const name = rel.slice(0, -'.spec.ts'.length);
      if (filter.pattern && !name.includes(filter.pattern)) continue;

      // meta 与 spec 同目录
      const metaFile = specFile.replace(/\.spec\.ts$/, '.meta.json');
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
      if (priorityFilter && (!meta.priority || !priorityFilter.has(meta.priority))) continue;
      if (filter.auth && meta.auth !== filter.auth) continue;
      // module / group 过滤：按 meta 字段精确匹配；name 前缀与 group 等价时也允许匹配
      if (filter.group) {
        const groupFromName = name.includes('/') ? name.split('/')[0] : null;
        const effectiveGroup = meta.group ?? groupFromName ?? null;
        if (effectiveGroup !== filter.group) continue;
      }
      if (filter.module && meta.module !== filter.module) continue;

      const pomRelative = meta.pageObject.enabled && meta.pageObject.file
        ? pathRelative(this.cwd, resolve(this.casesDir, meta.pageObject.file))
        : null;

      const groupFromName = name.includes('/') ? name.split('/')[0] : null;
      summaries.push({
        name,
        description: meta.description,
        priority: meta.priority,
        auth: meta.auth,
        module: meta.module ?? undefined,
        group: meta.group ?? groupFromName ?? undefined,
        tags: meta.tags,
        status: meta.stats.lastStatus,
        lastRunAt: meta.stats.lastRunAt,
        specPath: pathRelative(this.cwd, specFile),
        metaPath: pathRelative(this.cwd, metaFile),
        pageObjectFile: pomRelative,
        reviewVerdict: meta.review?.verdict,
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
   * - 落盘前先 normalize（容错 PI 输出）+ validate（强制 priority 等域）
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

    // 任务 3：归一化（容错 PI 输出）+ 校验（严格 enum）
    const { value: normalized, warnings } = normalizeCaseMeta({
      priority: input.priority,
      tags: input.tags,
      group: input.group,
      module: input.module,
      linkedTickets: input.linkedTickets,
      auth: input.auth,
    });
    for (const w of warnings) logger.warn(`[case:${input.name}] ${w}`);

    // priority 是 generate 命令强制传入的；若此处仍为 null，说明调用方没传，抛错
    if (normalized.priority === null) {
      throw new CliError({
        code: ExitCode.USAGE_ERROR,
        message: `用例 ${input.name} 缺少 priority（必须为 ${input.priority === undefined ? 'CLI --priority 参数' : 'P0|P1|P2|P3 之一'}）`,
      });
    }

    const candidateMeta: Partial<CaseMeta> = {
      name: input.name,
      description: input.description,
      priority: normalized.priority,
      group: normalized.group ?? undefined,
      module: normalized.module ?? undefined,
      linkedTickets: normalized.linkedTickets.length > 0 ? normalized.linkedTickets : undefined,
      auth: normalized.auth ?? undefined,
      tags: normalized.tags,
    };
    throwIfInvalid(candidateMeta);

    ensureDir(this.casesDir);
    // name 含 group 前缀（如 "auth/login-success"）时确保子目录存在
    const group = input.name.includes('/') ? dirname(this.specPath(input.name)) : this.casesDir;
    if (group !== this.casesDir) ensureDir(group);
    const now = new Date().toISOString();
    const meta: CaseMeta = {
      name: input.name,
      description: input.description,
      priority: normalized.priority,
      group: normalized.group ?? undefined,
      module: normalized.module ?? undefined,
      linkedTickets:
        normalized.linkedTickets.length > 0 ? normalized.linkedTickets : undefined,
      createdAt: now,
      updatedAt: now,
      tags: dedupe(normalized.tags),
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
      // 默认新生成用例为待裁决；调用方可在 review.reopen() 或后续 updateReview() 中改写。
      review: { verdict: 'pending' as const },
    };

    const specFile = this.specPath(input.name);
    const metaFile = this.metaPath(input.name);
    let pageObjectPathResult: string | null = null;
    let normalizedSpecCode = specCode;

    // 兜底：spec.ts 落盘前对 POM import 路径做规范化（见 rewriteSpecImports 注释）
    let pomAbsoluteFile: string | null = null;
    if (input.pageObject?.enabled && input.pageObject?.code && input.pageObject.file) {
      pomAbsoluteFile = resolve(this.casesDir, input.pageObject.file);
      const rewriteResult = rewriteSpecImports(
        normalizedSpecCode,
        dirname(specFile),
        pomAbsoluteFile,
      );
      normalizedSpecCode = rewriteResult.code;
      if (rewriteResult.changed) {
        logger.warn(
          `[case:${input.name}] spec.ts 中 POM import 路径已自动规范化（ESM 路径错位或缺扩展名）`,
        );
      }
    }

    try {
      writeFileSync(specFile, normalizedSpecCode, 'utf-8');
      writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf-8');

      if (pomAbsoluteFile !== null && input.pageObject?.code) {
        ensureDir(dirname(pomAbsoluteFile));
        writeFileSync(pomAbsoluteFile, input.pageObject.code, 'utf-8');
        pageObjectPathResult = pomAbsoluteFile;
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

    // 任务 3：patch 中的可写字段也走归一化+校验
    const normalizedPatch: Partial<CaseMeta> = { ...patch };
    if (patch.priority !== undefined || patch.tags !== undefined || patch.group !== undefined ||
        patch.module !== undefined || patch.linkedTickets !== undefined) {
      const { value, warnings } = normalizeCaseMeta({
        priority: patch.priority,
        tags: patch.tags,
        group: patch.group,
        module: patch.module,
        linkedTickets: patch.linkedTickets,
        auth: patch.auth,
      });
      for (const w of warnings) logger.warn(`[case:${name}] ${w}`);
      normalizedPatch.priority = value.priority ?? undefined;
      normalizedPatch.tags = value.tags;
      normalizedPatch.group = value.group ?? undefined;
      normalizedPatch.module = value.module ?? undefined;
      normalizedPatch.linkedTickets = value.linkedTickets.length > 0 ? value.linkedTickets : undefined;
      normalizedPatch.auth = value.auth ?? undefined;
    }
    throwIfInvalid({ ...current, ...normalizedPatch });

    const next: CaseMeta = {
      ...current,
      ...normalizedPatch,
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
   * 更新用例的 review 状态。
   * - 用例不存在抛 NOT_FOUND
   * - 不变更 name / createdAt / stats
   * - reviewedAt 始终刷为当前时间
   */
  updateReview(name: string, patch: ReviewState): CaseMeta {
    const current = this.get(name);
    if (!current) {
      throw new CliError({
        code: ExitCode.NOT_FOUND,
        message: `用例 ${name} 不存在`,
      });
    }

    const next: CaseMeta = {
      ...current,
      review: {
        verdict: patch.verdict,
        reviewer: patch.reviewer,
        reviewedAt: patch.reviewedAt ?? new Date().toISOString(),
        note: patch.note,
      },
      updatedAt: new Date().toISOString(),
    };

    try {
      writeFileSync(this.metaPath(name), JSON.stringify(next, null, 2) + '\n', 'utf-8');
    } catch (err) {
      throw new CliError({
        code: ExitCode.IO_ERROR,
        message: `更新用例 ${name} 的 review 状态失败：${(err as Error).message}`,
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
      // 兜底：spec.ts 落盘前对 POM import 路径做规范化（与 save() 一致）
      let normalizedSpecCode = specCode;
      const targetPomFile: string | null = pageObject
        ? resolve(this.casesDir, pageObject.file)
        : meta.pageObject.file
          ? resolve(this.casesDir, meta.pageObject.file)
          : null;
      if (targetPomFile) {
        const rewriteResult = rewriteSpecImports(
          normalizedSpecCode,
          dirname(this.specPath(name)),
          targetPomFile,
        );
        normalizedSpecCode = rewriteResult.code;
        if (rewriteResult.changed) {
          logger.warn(
            `[case:${name}] spec.ts 中 POM import 路径已自动规范化（ESM 路径错位或缺扩展名）`,
          );
        }
      }

      writeFileSync(this.specPath(name), normalizedSpecCode, 'utf-8');
      if (pageObject) {
        const pomFile = targetPomFile as string;
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
    const prev = meta.stats ?? emptyStats();
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

/**
 * 递归收集目录树下所有 .spec.ts 文件绝对路径。
 * - 跳过 pages/ 子目录（POM 不属于用例）
 */
function collectSpecFiles(rootDir: string): string[] {
  const out: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        // 跳过 Page Object 目录与运行产物目录
        if (entry === 'pages' || entry === 'node_modules' || entry.startsWith('.')) continue;
        walk(full);
      } else if (stat.isFile() && entry.endsWith('.spec.ts')) {
        out.push(full);
      }
    }
  }

  walk(rootDir);
  return out;
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
  const parsed = JSON.parse(raw) as Partial<CaseMeta>;
  // 兜底可选字段：用户手写或老格式 meta.json 可能缺 stats/tags，
  // 不兜底会导致 applyRunStats / list 直接炸（前者会刷 warn，后者静默丢用例）
  const merged: Partial<CaseMeta> = {
    ...parsed,
    tags: parsed.tags ?? [],
    stats: parsed.stats ?? emptyStats(),
  };
  return merged as CaseMeta;
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

// 保留 normalizeTags 的别名导出，便于测试或外部引用
export { normalizeTags };
