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

export interface GenerateOptions {
  url?: string;
  name?: string;
  pageObject?: boolean;
  /** 任务 2：必须传入的优先级，缺省时报错 */
  priority?: Priority;
  /**
   * 本次生成使用的 model（provider/id），覆盖 config.agent.model。
   * 推荐通过 `auto-test models select` 设置默认；这里仅做一次性覆盖。
   */
  model?: string;
  tag?: string[];
  json?: boolean;
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

export async function generateCommand(
  description: string,
  options: GenerateOptions,
): Promise<GenerateResult> {
  if (!description || description.trim().length === 0) {
    throw new CliError({ code: ExitCode.USAGE_ERROR, message: '缺少需求描述' });
  }

  // 任务 2：--priority 是必填项，避免 LLM 自由发挥污染冒烟集
  if (!options.priority || !(PRIORITIES as readonly string[]).includes(options.priority)) {
    throw new CliError({
      code: ExitCode.USAGE_ERROR,
      message: `必须通过 --priority 指定用例优先级（${PRIORITIES.join('|')}）`,
      hint: `示例：auto-test generate "管理员登录跳转 dashboard" --priority P0`,
    });
  }
  const priority: Priority = options.priority;

  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const { caseStore } = createStores(cwd);

  // 探索模式
  let exploreResult: ExploreResult | null = null;
  const mode: GenerateResult['mode'] = options.url
    ? 'explore-assisted'
    : 'description-only';

  if (options.url) {
    logger.info(`探索 URL: ${options.url}`);
    exploreResult = await explorePage({
      url: options.url,
      headless: config.explore.headless,
      timeoutMs: config.explore.timeoutMs,
      maxElements: config.explore.maxElements,
      waitUntil: config.explore.waitUntil,
    });
    logger.info(`探索完成: title="${exploreResult.title}" (${exploreResult.durationMs}ms)`);
  }

  // prompt
  const prompt = buildGeneratePrompt({
    description,
    mode,
    selectorPolicy: config.generation.selectorPolicy,
    exploredUrl: exploreResult?.url ?? null,
    pageObjectEnabled: !!options.pageObject,
    defaultPriority: priority,
    accessibilitySnapshot: exploreResult?.accessibilitySnapshot,
    interactiveElements: exploreResult?.interactiveElements,
  });

  // 工具定义
  const customTools = createCaseTools({
    caseStore,
    defaultGeneration: {
      mode,
      model: config.agent.model,
      exploredUrl: exploreResult?.url ?? null,
      selectorPolicy: config.generation.selectorPolicy,
    },
    defaultSourceInput: description,
    defaultSourceType: 'generated',
    defaultPriority: priority,
  });

  // session
  const session = await createAgentSession({
    model: options.model ?? config.agent.model,
    customTools,
    toolsAllowlist: [...CASE_TOOL_NAMES],
    onToolCall: (event) => {
      const name = event.input.name;
      logger.info(`tool_call: ${event.name}${name ? `(${String(name)})` : ''}`);
    },
  });

  const start = Date.now();
  let result: Awaited<ReturnType<typeof session.prompt>>;
  try {
    result = await session.prompt(prompt);
  } finally {
    await session.dispose();
  }
  const durationMs = Date.now() - start;

  // 提取保存的用例
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
      specPath: caseStore.specPath(targetName),
      metaPath: caseStore.metaPath(targetName),
      pageObjectPath:
        caseStore.exists(targetName) && caseStore.get(targetName)?.pageObject.file
          ? caseStore.pageObjectPath(targetName)
          : null,
    };
  }

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

  if (options.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    logger.info(`生成完成 (${durationMs}ms)`);
    if (savedCase) {
      logger.info(`用例: ${savedCase.name}`);
      logger.info(`spec: ${savedCase.specPath}`);
      logger.info(`meta: ${savedCase.metaPath}`);
      if (savedCase.pageObjectPath) {
        logger.info(`pom:  ${savedCase.pageObjectPath}`);
      }
    } else {
      logger.warn('LLM 未调用 save_case / update_case，请检查 prompt 模板或工具注册');
    }
    if (result.content && result.content.trim().length > 0) {
      process.stdout.write('\n--- agent 输出 ---\n');
      process.stdout.write(result.content.trim() + '\n');
    }
  }

  return out;
}