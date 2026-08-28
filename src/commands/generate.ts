/**
 * generate 子命令：描述 → 可选探索 → pi-agent 生成 → 落盘
 *
 * 流程：
 *   1. 加载 config + CaseStore
 *   2. 若指定 --url，调用 explorePage 提取 a11y 快照
 *   3. 构造生成 prompt（含工具清单、风格约束、可选探索上下文）
 *   4. 创建 pi-agent session，注入 4 个 CaseStore 工具（通过 customTools）
 *   5. 调用 prompt，等待 LLM 通过 save_case 落盘
 *   6. 输出结果（JSON / 人类可读）
 *
 * 批量模式（v2）：
 *   - description 支持逗号分隔的多条（如 "用例1, 用例2, 用例3"）
 *   - --concurrency 控制并发数（默认 2）
 *   - 同一 URL 的多条用例共享一次 explore（URL 去重）
 *   - 失败隔离：单条失败不影响其他；JSON 模式返回 results[]，人类模式按 [i/N] 进度打印
 */
import { createStores } from '../store/index.js';
import { loadConfig } from '../config.js';
import { CliError, ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { createAgentSession } from '../agent/session.js';
import { createCaseTools, CASE_TOOL_NAMES } from '../agent/tools.js';
import { buildGeneratePrompt } from '../agent/prompts.js';
import { explorePage, type ExploreResult } from '../agent/explore.js';
import { PRIORITIES, type Priority } from '../store/types.js';
import { normalizeGroup, normalizeModule } from '../utils/normalize-meta.js';
import { createLimit, type Limit } from '../utils/concurrency.js';
import { confirm, askText, canPromptInteractive } from '../utils/prompt.js';
import { pickExample, buildClassifyPrompt, type ClassifyOutput } from '../agent/prompts.js';
import { tryTemplateFastPath } from '../agent/templates/index.js';
import type { TemplateFastPathHit } from '../agent/templates/index.js';
import { withRetry } from '../utils/retry.js';
import {
  createState,
  loadState,
  recordCompletion,
  finishState,
  deleteState,
  completedSet,
  DEFAULT_CHECKPOINT_DIR,
  type BatchState,
} from '../agent/checkpoint.js';
import type { AutoTestConfig } from '../config.js';
import type { CaseStore } from '../store/index.js';

export interface GenerateOptions {
  url?: string;
  name?: string;
  pageObject?: boolean;
  /** 任务 2：必须传入的优先级，缺省时报错 */
  priority?: Priority;
  /**
   * 本次生成使用的 model（provider/id），覆盖 config.agent.model。
   * 推荐通过 `specmint models select` 设置默认；这里仅做一次性覆盖。
   */
  model?: string;
  tag?: string[];
  json?: boolean;
  /**
   * 显式指定的模块中文名（如 "用户认证"）。
   * - 非空：CLI 强制覆盖 LLM 推断值
   * - 未传 / 空字符串：LLM 自由推断
   */
  module?: string;
  /**
   * 显式指定的功能模块分组（kebab-case，如 "auth"）。
   * - 非空：CLI 强制覆盖 LLM 推断值并校验 name 前缀一致
   * - 未传 / 空字符串：LLM 自由推断
   */
  group?: string;
  /**
   * 探索快照缓存控制（来自 CLI `--no-explore-cache` / `--explore-cache-ttl`）。
   * - `exploreCache` 字段名是 commander `--no-explore-cache` 的默认属性名（boolean）。
   *   默认 true；命令行加 `--no-explore-cache` 时变 false。
   * - `exploreCacheTtl` 字段名是 commander `--explore-cache-ttl <ms>` 的默认属性名（number）。
   * 未传则用 config.explore.cache.* 默认值。
   */
  exploreCache?: boolean;
  exploreCacheTtl?: number;
  /**
   * 批量生成时的并发数（来自 CLI `--concurrency <n>`）。
   * - 单条用例：忽略，沿用串行流程
   * - 多条用例：>=1 的正整数，默认 2
   * - 仅约束"生成 + 落盘"阶段；explore 阶段仍按 URL 去重单飞
   */
  concurrency?: number;
  /**
   * Few-shot 示例控制（来自 CLI `--example` / `--no-example`）。
   * - string：显式指定 example 名（必须存在于 EXAMPLE_LIBRARY）
   * - false：关闭 example 注入
   * - undefined：按 description 关键词自动匹配
   */
  example?: string | boolean;
  /**
   * 模板快路径（来自 CLI `--template <name>` / `--no-template`）。
   * - string：显式指定模板（参数不足时直接报错，不静默回退）
   * - false：禁用快路径
   * - undefined：按描述关键词自动匹配，未命中回退 LLM
   */
  template?: string | boolean;
  /** 模板参数覆盖（来自 CLI `--set key=value`，可重复），优先级最高 */
  setParams?: Record<string, string>;
  /**
   * 交互式确认（来自 CLI `--interactive`）。
   * 仅在 module/group 都未指定时生效：跑一次轻量 LLM 分类 → 让用户确认/修改元信息 → 再正式生成。
   * 非 TTY / SPECMINT_NO_INTERACTIVE=1 时自动降级为跳过交互。
   */
  interactive?: boolean;
  /**
   * 失败重试次数（来自 CLI `--retry <n>`）。默认 3（总共最多 4 次尝试）。
   * 0 表示不重试。仅对"可重试错误"（网络/超时/限流/5xx）生效。
   */
  retry?: number;
  /**
   * 重试首次退避（ms，来自 CLI `--retry-backoff <ms>`）。默认 1000。
   * 实际退避 = baseDelayMs * 2^attempt + ±25% 抖动，单次上限 30s。
   */
  retryBackoffMs?: number;
  /**
   * Checkpoint 目录（来自 CLI `--checkpoint <dir>`）。
   * 默认 `.specmint/runs/`。仅批量模式生效：每条用例完成后增量写一份 state file，
   * 全部成功时自动清理，部分失败保留供 `--resume` 诊断。
   */
  checkpointDir?: string;
  /**
   * 禁用 checkpoint 写入（来自 CLI `--no-checkpoint`）。
   * 单条模式默认就不写；批量模式默认写。
   */
  noCheckpoint?: boolean;
  /**
   * 从 state file 恢复（来自 CLI `--resume <file>`）。
   * 加载已完成项并跳过，仅跑剩余未完成的 description。
   */
  resumeFile?: string;
}

export interface GenerateSavedCase {
  name: string;
  specPath: string;
  metaPath: string;
  pageObjectPath: string | null;
}

export interface GenerateResult {
  ok: boolean;
  mode: 'description-only' | 'explore-assisted';
  description: string;
  durationMs: number;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; isError?: boolean }>;
  savedCase: GenerateSavedCase | null;
  content: string;
  error?: string;
}

/**
 * 批量结果：聚合 N 条 GenerateResult + 汇总信息。
 * 单条用例时仍返回 GenerateResult（保持向后兼容，不破坏现有 JSON 输出契约）。
 */
export interface GenerateBatchResult {
  ok: boolean;
  total: number;
  succeeded: number;
  failed: number;
  totalDurationMs: number;
  concurrency: number;
  results: GenerateResult[];
}

export interface BatchContext {
  cwd: string;
  config: AutoTestConfig;
  caseStore: CaseStore;
  options: GenerateOptions;
  module?: string | undefined;
  group?: string | undefined;
  priority: Priority;
  /**
   * URL → 探索结果。同 URL 多个用例复用，避免重复打开浏览器。
   * 由 generateCommand 在并发开始前按 URL 去重预热；并发过程中只读。
   */
  exploreByUrl: Map<string, ExploreResult>;
  /** Checkpoint state + 目录。批量模式下用于增量持久化与 --resume 恢复。 */
  state?: BatchState | undefined;
  checkpointDir?: string | undefined;
}

export async function generateCommand(
  description: string,
  options: GenerateOptions,
): Promise<GenerateResult | GenerateBatchResult> {
  if (!description || description.trim().length === 0) {
    throw new CliError({ code: ExitCode.USAGE_ERROR, message: '缺少需求描述' });
  }

  // 任务 2：--priority 是必填项，避免 LLM 自由发挥污染冒烟集
  if (!options.priority || !(PRIORITIES as readonly string[]).includes(options.priority)) {
    throw new CliError({
      code: ExitCode.USAGE_ERROR,
      message: `必须通过 --priority 指定用例优先级（${PRIORITIES.join('|')}）`,
      hint: `示例：specmint generate "管理员登录跳转 dashboard" --priority P0`,
    });
  }
  const priority: Priority = options.priority;

  // CLI 显式传 --module / --group 时强校验（用 normalize* 与 LLM 侧规则保持一致）
  let module: string | undefined;
  if (options.module !== undefined && options.module !== '') {
    const m = normalizeModule(options.module);
    if (m === null) {
      throw new CliError({
        code: ExitCode.USAGE_ERROR,
        message: `--module "${options.module}" 非法：模块名不能为空`,
        hint: '示例：--module "用户认证"',
      });
    }
    module = m;
  }
  let group: string | undefined;
  if (options.group !== undefined && options.group !== '') {
    const g = normalizeGroup(options.group);
    if (g === null) {
      throw new CliError({
        code: ExitCode.USAGE_ERROR,
        message: `--group "${options.group}" 非法：必须为 kebab-case（小写字母/数字/连字符，如 "auth"）`,
        hint: '示例：--group auth  或  --group user-profile',
      });
    }
    group = g;
  }

  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const { caseStore } = createStores(cwd);

  // 拆分多描述。逗号 + trim + 去空 + 去重（保持首次出现的顺序）。
  const descriptions = parseDescriptions(description);
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const mode: GenerateResult['mode'] = options.url
    ? 'explore-assisted'
    : 'description-only';

  // 交互式确认：仅在单条 + module/group 都未指定 + --interactive + TTY 时生效
  if (
    options.interactive &&
    descriptions.length === 1 &&
    !module &&
    !group &&
    canPromptInteractive()
  ) {
    const inferred = await runInteractiveClassify(
      descriptions[0]!,
      options.model ?? config.agent.model,
      { retries: options.retry ?? 3, baseDelayMs: options.retryBackoffMs ?? 1000 },
    );
    if (inferred) {
      const newModule = await askText('模块名 (中文)', inferred.module);
      const newGroup = await askText('功能分组 (kebab-case)', inferred.group);
      // 用户实际输入了非空值才覆盖
      if (newModule && newModule.trim().length > 0) {
        const norm = normalizeModule(newModule);
        if (norm) module = norm;
      }
      if (newGroup && newGroup.trim().length > 0) {
        const norm = normalizeGroup(newGroup);
        if (norm) group = norm;
      }
      logger.info(
        `已确认元信息: module="${module ?? inferred.module}", group="${group ?? inferred.group}"`,
      );
    } else {
      logger.warn('分类 LLM 调用失败，跳过交互式确认');
    }
  } else if (options.interactive && descriptions.length > 1) {
    logger.info(
      '批量模式不支持逐条交互式确认，请用 --module / --group 显式指定（或关闭 --interactive）',
    );
  }

  // 共享上下文：explore 结果按 URL 复用
  const ctx: BatchContext = {
    cwd,
    config,
    caseStore,
    options,
    module,
    group,
    priority,
    exploreByUrl: new Map(),
  };

  // === 单条路径：完全沿用旧行为，避免破坏既有 JSON 输出契约与 CLI 输出风格 ===
  if (descriptions.length === 1) {
    const exploreResult = await resolveExplore(descriptions[0]!, ctx);
    const result = await runSingleCase(descriptions[0]!, ctx, 1, 1, exploreResult);
    printSingleResult(result, options);
    return result;
  }

  // === 批量路径：checkpoint + 探索 + 并发调度 ===

  // 1. --resume：从 state file 恢复，过滤已完成的 description
  const checkpointDir = options.checkpointDir ?? DEFAULT_CHECKPOINT_DIR;
  let state: BatchState | undefined;
  let pending = descriptions;
  if (options.resumeFile) {
    const loaded = loadState(options.resumeFile);
    if (!loaded) {
      throw new CliError({
        code: ExitCode.USAGE_ERROR,
        message: `--resume 加载失败: state file "${options.resumeFile}" 不存在或损坏`,
        hint: '检查文件路径，或删除 state file 后重跑',
      });
    }
    if (loaded.cwd !== cwd) {
      logger.warn(
        `resume state 来自不同目录 (${loaded.cwd})，当前 ${cwd}。继续但可能不一致`,
      );
    }
    const done = completedSet(loaded);
    pending = descriptions.filter((d) => !done.has(d));
    const skipped = descriptions.length - pending.length;
    logger.info(
      `resume: 共 ${descriptions.length} 条，跳过 ${skipped} 条已完成，剩余 ${pending.length} 条待跑`,
    );
    state = loaded;
  }

  // 2. 创建新 state（除非 resume 已有 / 用户禁用）
  if (!state && !options.noCheckpoint) {
    state = createState(checkpointDir, {
      cwd,
      descriptions,
      url: options.url,
      priority,
      concurrency,
    });
    logger.info(`checkpoint: ${state.id}.state.json（每完成一条自动增量写）`);
  }

  ctx.state = state;
  ctx.checkpointDir = state ? checkpointDir : undefined;

  return runBatch(pending, ctx, concurrency);
}

/**
 * 跑一次轻量 LLM 分类，解析 JSON 返回。
 * 失败抛错由调用方决定如何降级。
 *
 * 实现要点：
 * - 复用 createAgentSession（与正常生成同 model），prompt 极短（< 200 tokens）
 * - 解析时容错：可能被包在 Markdown ```json ... ``` 里
 */
async function runInteractiveClassify(
  description: string,
  model: string | undefined,
  retryOpts: { retries: number; baseDelayMs: number },
): Promise<ClassifyOutput | null> {
  const prompt = buildClassifyPrompt({ description });
  let session;
  try {
    session = await createAgentSession({
      model,
      customTools: [], // 分类不需要工具
      toolsAllowlist: [],
    });
  } catch (err) {
    logger.warn(`分类 LLM session 创建失败: ${(err as Error).message}`);
    return null;
  }
  try {
    const result = await withRetry(
      () => session!.prompt(prompt),
      {
        retries: retryOpts.retries,
        baseDelayMs: retryOpts.baseDelayMs,
        onRetry: ({ attempt, delayMs, error }) =>
          logger.warn(`分类 LLM 第 ${attempt} 次失败，${delayMs}ms 后重试: ${error.message}`),
      },
    );
    const parsed = parseClassifyOutput(result.content);
    if (!parsed) {
      logger.warn('分类 LLM 输出无法解析为 JSON');
      return null;
    }
    // 校验必填字段
    if (!parsed.module || !parsed.group || !parsed.caseName || !parsed.summary) {
      logger.warn('分类 LLM 输出缺字段');
      return null;
    }
    // 校验 group 格式
    if (normalizeGroup(parsed.group) === null) {
      logger.warn(`分类 LLM 输出 group 非法: ${parsed.group}`);
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn(`分类 LLM 调用失败: ${(err as Error).message}`);
    return null;
  } finally {
    await session.dispose();
  }
}

/**
 * 容错解析 classify 输出。处理三种典型情况：
 * 1. 纯 JSON：`{"module":"...",...}`
 * 2. Markdown 围栏：`` ```json\n{...}\n``` ``
 * 3. 前置/后置杂文本：提取第一段 {...}
 */
/**
 * 容错解析 classify 输出（导出供测试）。处理三种典型情况：
 * 1. 纯 JSON：`{"module":"...",...}`
 * 2. Markdown 围栏：`` ```json\n{...}\n``` ``
 * 3. 前置/后置杂文本：提取第一段 {...}
 */
export function parseClassifyOutput(content: string): ClassifyOutput | null {
  const text = content.trim();
  // 1. 尝试直接 parse
  try {
    return JSON.parse(text) as ClassifyOutput;
  } catch {
    // 继续尝试
  }
  // 2. Markdown 围栏
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]!.trim()) as ClassifyOutput;
    } catch {
      // 继续尝试
    }
  }
  // 3. 提取第一段 {...}
  const braceMatch = text.match(/\{[\s\S]*?\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]) as ClassifyOutput;
    } catch {
      // 全部失败
    }
  }
  return null;
}

/**
 * 拆分 description。
 * - 接受逗号（中/全角 + 半角）分隔
 * - trim 后非空才保留
 * - 保留首次出现的顺序去重
 */
export function parseDescriptions(raw: string): string[] {
  const parts = raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * 解析当前 case 所需 explore 结果。
 * - options.url 存在：先看 ctx.exploreByUrl 缓存，未命中则跑一次 explorePage
 * - 无 URL：返回 null（description-only 模式）
 * - 仅用于单条路径；批量路径在 runBatch 内统一预热
 */
async function resolveExplore(
  _description: string,
  ctx: BatchContext,
): Promise<ExploreResult | null> {
  if (!ctx.options.url) return null;
  return runExploreForUrl(ctx.options.url, ctx);
}

/**
 * 实际跑一次 explorePage（带缓存层），并把结果写回 ctx.exploreByUrl 复用。
 * 失败抛错，让上层按"整批失败"语义处理。
 */
async function runExploreForUrl(
  url: string,
  ctx: BatchContext,
): Promise<ExploreResult> {
  const cached = ctx.exploreByUrl.get(url);
  if (cached) return cached;

  const config = ctx.config;
  const cacheEnabled =
    ctx.options.exploreCache === false
      ? false
      : (config.explore.cache?.enabled !== false);
  const cacheTtl = ctx.options.exploreCacheTtl ?? config.explore.cache?.ttlMs ?? 600_000;
  const cacheDir = config.explore.cache?.dir ?? '.specmint/cache/explore';

  logger.info(`探索 URL: ${url}`);
  const result = await explorePage({
    url,
    headless: config.explore.headless,
    timeoutMs: config.explore.timeoutMs,
    maxElements: config.explore.maxElements,
    waitUntil: config.explore.waitUntil,
    cache: { enabled: cacheEnabled, dir: cacheDir, ttlMs: cacheTtl },
  });
  const cacheTag = result.fromCache
    ? ' [cache hit]'
    : cacheEnabled
      ? ' [cached]'
      : '';
  logger.info(`探索完成: title="${result.title}" (${result.durationMs}ms)${cacheTag}`);
  ctx.exploreByUrl.set(url, result);
  return result;
}

/**
 * 模板快路径落盘：直接渲染 spec 并保存，跳过 LLM。
 * name 唯一化：批量模式下多条描述命中同一模板时自动追加 -2/-3 后缀。
 */
function saveFromTemplate(
  fast: TemplateFastPathHit,
  opts: {
    ctx: BatchContext;
    description: string;
    mode: GenerateResult['mode'];
    exploreResult: ExploreResult | null;
    start: number;
  },
): GenerateResult {
  const { ctx, description, mode, exploreResult, start } = opts;
  const group = ctx.group ?? fast.render.group;
  const module = ctx.module ?? fast.render.module;

  let name = fast.render.name;
  if (group && !name.includes('/')) name = `${group}/${name}`;
  let finalName = name;
  let suffix = 2;
  while (ctx.caseStore.exists(finalName)) {
    const slashIdx = name.lastIndexOf('/');
    finalName =
      slashIdx === -1
        ? `${name}-${suffix}`
        : `${name.slice(0, slashIdx + 1)}${name.slice(slashIdx + 1)}-${suffix}`;
    suffix++;
  }

  ctx.caseStore.save(
    {
      name: finalName,
      description,
      priority: ctx.priority,
      group,
      module,
      tags: fast.render.tags,
      source: { type: 'generated', input: description },
      generation: {
        mode,
        model: `template:${fast.templateName}`,
        exploredUrl: exploreResult?.url ?? null,
        selectorPolicy: ctx.config.generation.selectorPolicy,
      },
    },
    fast.render.code,
  );

  return {
    ok: true,
    mode,
    description,
    durationMs: Date.now() - start,
    toolCalls: [{ name: 'save_case', input: { name: finalName, template: fast.templateName } }],
    savedCase: {
      name: finalName,
      specPath: ctx.caseStore.specPath(finalName),
      metaPath: ctx.caseStore.metaPath(finalName),
      pageObjectPath: null,
    },
    content: `template fast-path: ${fast.templateName}`,
  };
}

/**
 * 单条用例的完整生成流程。
 * 设计为可并发调用（每次都独立 createAgentSession + dispose），无共享可变状态。
 */
async function runSingleCase(
  description: string,
  ctx: BatchContext,
  index: number,
  total: number,
  exploreResult: ExploreResult | null,
): Promise<GenerateResult> {
  const start = Date.now();
  const mode: GenerateResult['mode'] = ctx.options.url
    ? 'explore-assisted'
    : 'description-only';
  const prefix = total > 1 ? `[${index}/${total}] ` : '';
  if (total > 1) {
    logger.info(`${prefix}开始: ${description}`);
  }

  try {
    // --- 模板快路径：命中则跳过 LLM，直接渲染落盘 ---
    const templateOpt = ctx.options.template;
    if (templateOpt !== false) {
      const forced = typeof templateOpt === 'string' ? templateOpt : undefined;
      const fast = tryTemplateFastPath(
        description,
        {
          overrides: ctx.options.setParams ?? {},
          explore: exploreResult,
          url: ctx.options.url,
          description,
        },
        forced,
      );
      if ('render' in fast) {
        logger.info(`${prefix}template fast-path: ${fast.templateName}（跳过 LLM）`);
        return saveFromTemplate(fast, { ctx, description, mode, exploreResult, start });
      }
      if (forced) {
        // 显式指定模板但参数不足：直接报错，不静默换路径（用户点名要快路径）
        throw new CliError({
          code: ExitCode.USAGE_ERROR,
          message: fast.reason,
          hint: '用 --set key=value 补齐缺失参数，或去掉 --template 走 LLM 生成',
        });
      }
      logger.info(`${prefix}模板未命中（${fast.reason}），走 LLM 生成`);
    }

    // Few-shot example：CLI --example=false 关闭；--example=<name> 强制指定；undefined 按 description 关键词自动匹配
    const exampleOverride = ctx.options.example;
    const exampleContent =
      exampleOverride === false
        ? null
        : exampleOverride !== undefined && typeof exampleOverride === 'string'
          ? pickExample(description, exampleOverride)
          : pickExample(description, undefined);

    const prompt = buildGeneratePrompt({
      description,
      mode,
      selectorPolicy: ctx.config.generation.selectorPolicy,
      exploredUrl: exploreResult?.url ?? null,
      pageObjectEnabled: !!ctx.options.pageObject,
      defaultPriority: ctx.priority,
      accessibilitySnapshot: exploreResult?.accessibilitySnapshot,
      interactiveElements: exploreResult?.interactiveElements,
      cliModule: ctx.module ?? null,
      cliGroup: ctx.group ?? null,
      exampleContent,
    });

    const customTools = createCaseTools({
      caseStore: ctx.caseStore,
      defaultGeneration: {
        mode,
        model: ctx.config.agent.model,
        exploredUrl: exploreResult?.url ?? null,
        selectorPolicy: ctx.config.generation.selectorPolicy,
      },
      defaultSourceInput: description,
      defaultSourceType: 'generated',
      defaultPriority: ctx.priority,
      defaultModule: ctx.module,
      defaultGroup: ctx.group,
    });

    // 流式文本：写到 stderr（避免污染 --json 的 stdout 契约）。仅非批量模式打，
    // 批量模式下多个 session 并发写 stderr 会交错，反而看不清，所以批量只打工具调用行。
    const streamText = total > 1 ? null : (delta: string) => {
      process.stderr.write(delta);
    };

    const session = await createAgentSession({
      model: ctx.options.model ?? ctx.config.agent.model,
      customTools,
      toolsAllowlist: [...CASE_TOOL_NAMES],
      onToolCall: (event) => {
        const name = event.input.name;
        if (total > 1) {
          logger.info(`${prefix}tool_call: ${event.name}${name ? `(${String(name)})` : ''}`);
        } else {
          logger.info(`tool_call: ${event.name}${name ? `(${String(name)})` : ''}`);
        }
      },
      onText: streamText ?? undefined,
    });

    if (total > 1) {
      logger.info(`${prefix}prompting...`);
    } else {
      logger.info(`prompting... (流式输出见 stderr)`);
    }

    let result: Awaited<ReturnType<typeof session.prompt>>;
    try {
      result = await withRetry(() => session.prompt(prompt), {
        retries: ctx.options.retry ?? 3,
        baseDelayMs: ctx.options.retryBackoffMs ?? 1000,
        onRetry: ({ attempt, delayMs, error }) => {
          const tag = total > 1 ? prefix : '';
          logger.warn(
            `${tag}prompt 第 ${attempt} 次失败，${delayMs}ms 后重试: ${error.message}`,
          );
        },
      });
    } finally {
      if (streamText) process.stderr.write('\n'); // 流式结束后换行
      await session.dispose();
    }

    const saveCall = result.toolCalls.find((c) => c.name === 'save_case');
    const updateCall = result.toolCalls.find((c) => c.name === 'update_case');
    const targetCall = saveCall ?? updateCall;
    const targetName =
      targetCall && typeof targetCall.input.name === 'string'
        ? targetCall.input.name
        : null;

    let savedCase: GenerateSavedCase | null = null;
    if (targetName) {
      savedCase = {
        name: targetName,
        specPath: ctx.caseStore.specPath(targetName),
        metaPath: ctx.caseStore.metaPath(targetName),
        pageObjectPath:
          ctx.caseStore.exists(targetName) && ctx.caseStore.get(targetName)?.pageObject.file
            ? ctx.caseStore.pageObjectPath(targetName)
            : null,
      };
    }

    const durationMs = Date.now() - start;
    const out: GenerateResult = {
      ok: true,
      mode,
      description,
      durationMs,
      toolCalls: result.toolCalls.map((c) => ({
        name: c.name,
        input: c.input,
        isError: c.isError,
      })),
      savedCase,
      content: result.content,
    };
    if (total > 1) {
      logger.info(
        `${prefix}完成: ${savedCase?.name ?? '(no save_case called)'} (${durationMs}ms)`,
      );
    }
    return out;
  } catch (err) {
    const durationMs = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    if (total > 1) {
      logger.error(`${prefix}失败: ${errMsg}`);
    }
    return {
      ok: false,
      mode,
      description,
      durationMs,
      toolCalls: [],
      savedCase: null,
      content: '',
      error: errMsg,
    };
  }
}

/**
 * 批量执行：
 * 1. 按 URL 去重，预先串行跑 explorePage（写 ctx.exploreByUrl）
 * 2. 用 Limit 并发跑所有用例的 runSingleCase
 * 3. 聚合并输出
 */
async function runBatch(
  descriptions: string[],
  ctx: BatchContext,
  concurrency: number,
): Promise<GenerateBatchResult> {
  const totalStart = Date.now();
  const total = descriptions.length;

  // 1. 预热 explore：仅在有 URL 时才跑，且按 URL 去重单飞
  if (ctx.options.url) {
    try {
      await runExploreForUrl(ctx.options.url, ctx);
    } catch (err) {
      // explore 失败整批放弃：浏览器是稀有资源，不应该逐 case 重试
      throw err instanceof CliError
        ? err
        : new CliError({
            code: ExitCode.AGENT_ERROR,
            message: `批量探索失败: ${(err as Error).message}`,
            hint: '可加 --no-explore-cache 重试，或检查 URL 可达性',
          });
    }
  }

  // 2. 并发跑生成
  const limit: Limit = createLimit(concurrency);
  const tasks = descriptions.map((desc, i) =>
    limit.run(async () => {
      const r = await runSingleCase(
        desc,
        ctx,
        i + 1,
        total,
        ctx.options.url ? ctx.exploreByUrl.get(ctx.options.url) ?? null : null,
      );
      // 增量持久化：每条用例完成立即写 state（崩溃/Ctrl-C 也能恢复到此）
      if (ctx.state && ctx.checkpointDir) {
        recordCompletion(ctx.checkpointDir, ctx.state, {
          description: desc,
          ok: r.ok,
          name: r.savedCase?.name,
          specPath: r.savedCase?.specPath,
          durationMs: r.durationMs,
          error: r.error,
        });
      }
      return r;
    }),
  );
  const results = await Promise.all(tasks);

  const succeeded = results.filter((r) => r.ok).length;
  const failed = total - succeeded;

  const batchResult: GenerateBatchResult = {
    ok: failed === 0,
    total,
    succeeded,
    failed,
    totalDurationMs: Date.now() - totalStart,
    concurrency,
    results,
  };

  // 3. checkpoint 收尾
  if (ctx.state && ctx.checkpointDir) {
    finishState(
      ctx.checkpointDir,
      ctx.state,
      batchResult.totalDurationMs,
      failed === 0,
    );
    if (failed === 0) {
      // 全部成功才清理 state（部分失败保留供诊断）
      deleteState(ctx.checkpointDir, ctx.state);
      logger.info(`checkpoint: 全部成功，已清理 ${ctx.state.id}.state.json`);
    } else {
      logger.warn(
        `checkpoint: 有 ${failed} 条失败，state ${ctx.state.id}.state.json 已保留（可用 --resume 继续或人工诊断）`,
      );
    }
  }

  // 4. 输出
  if (ctx.options.json) {
    process.stdout.write(JSON.stringify(batchResult, null, 2) + '\n');
  } else {
    logger.info(
      `\n=== 批量完成: ${succeeded}/${total} 成功，${failed} 失败，并发=${concurrency}，总耗时 ${batchResult.totalDurationMs}ms ===`,
    );
    for (const r of results) {
      const saved = r.savedCase?.name ?? '(no save_case)';
      const err = r.error ? ` [ERROR: ${r.error}]` : '';
      logger.info(
        `  ${r.ok ? '✓' : '✗'} ${saved}  (${r.durationMs}ms)${err}`,
      );
    }
  }

  return batchResult;
}

/**
 * 单条路径的输出：与改造前的 generateCommand 行为完全一致
 * （沿用旧 JSON 形状与人类可读格式，向后兼容）。
 */
function printSingleResult(result: GenerateResult, options: GenerateOptions): void {
  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  logger.info(`生成完成 (${result.durationMs}ms)`);
  if (result.savedCase) {
    logger.info(`用例: ${result.savedCase.name}`);
    logger.info(`spec: ${result.savedCase.specPath}`);
    logger.info(`meta: ${result.savedCase.metaPath}`);
    if (result.savedCase.pageObjectPath) {
      logger.info(`pom:  ${result.savedCase.pageObjectPath}`);
    }
  } else if (!result.ok) {
    logger.error(`生成失败: ${result.error ?? 'unknown error'}`);
  } else {
    logger.warn('LLM 未调用 save_case / update_case，请检查 prompt 模板或工具注册');
  }
  if (result.content && result.content.trim().length > 0) {
    process.stdout.write('\n--- agent 输出 ---\n');
    process.stdout.write(result.content.trim() + '\n');
  }
}