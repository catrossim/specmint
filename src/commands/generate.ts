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
import { CaseStore } from '../store/case-store.js';
import { loadConfig } from '../config.js';
import { CliError, ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { createAgentSession } from '../agent/session.js';
import { createCaseTools, CASE_TOOL_NAMES } from '../agent/tools.js';
import { buildGeneratePrompt } from '../agent/prompts.js';
import { explorePage, type ExploreResult } from '../agent/explore.js';

export interface GenerateOptions {
  url?: string;
  name?: string;
  pageObject?: boolean;
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

  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const caseStore = new CaseStore({ cwd, casesDir: config.storage.casesDir });

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
  });

  // session
  const session = await createAgentSession({
    model: config.agent.model,
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