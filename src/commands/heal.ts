/**
 * heal 子命令：自动修复失败用例
 *
 * 流程：
 *   1. 读取用例 spec + meta
 *   2. 查找最近一次失败记录（错误信息、stack）
 *   3. 构造 heal prompt
 *   4. pi-agent 调用 update_case 工具覆盖修复
 *   5. 输出修复结果
 */
import { CaseStore } from '../store/case-store.js';
import { HistoryStore } from '../store/history-store.js';
import { loadConfig } from '../config.js';
import { CliError, ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { createAgentSession } from '../agent/session.js';
import { createCaseTools, CASE_TOOL_NAMES } from '../agent/tools.js';
import { buildHealPrompt } from '../agent/prompts.js';
import type { TestResult } from '../store/types.js';

export interface HealOptions {
  from?: string;
  json?: boolean;
}

export interface HealResult {
  ok: boolean;
  caseName: string;
  sourceRunId: string | null;
  durationMs: number;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; isError?: boolean }>;
  content: string;
}

export async function healCommand(
  caseName: string,
  options: HealOptions,
): Promise<HealResult> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const caseStore = new CaseStore({ cwd, casesDir: config.storage.casesDir });
  const historyStore = new HistoryStore({ cwd, reportsDir: config.storage.reportsDir });

  const data = caseStore.readWithCode(caseName);
  if (!data) {
    throw new CliError({ code: ExitCode.NOT_FOUND, message: `用例 ${caseName} 不存在` });
  }

  // 寻找最近一次失败记录
  let latestFailed: TestResult | null = null;
  let sourceRunId: string | null = options.from ?? null;

  if (sourceRunId) {
    const run = historyStore.getRun(sourceRunId);
    latestFailed =
      run?.results.find(
        (r) => r.caseName === caseName && (r.status === 'failed' || r.status === 'timedOut'),
      ) ?? null;
  } else {
    const recent = historyStore.listRuns({ limit: 20 });
    for (const summary of recent) {
      const run = historyStore.getRun(summary.runId);
      if (!run) continue;
      const failed = run.results.find(
        (r) => r.caseName === caseName && (r.status === 'failed' || r.status === 'timedOut'),
      );
      if (failed) {
        latestFailed = failed;
        sourceRunId = run.runId;
        break;
      }
    }
  }

  if (!latestFailed) {
    throw new CliError({
      code: ExitCode.NOT_FOUND,
      message: `用例 ${caseName} 没有失败记录，无法 heal`,
      hint: '先用 `auto-test run` 触发一次运行并产生失败',
    });
  }

  // prompt
  const prompt = buildHealPrompt({
    caseName,
    specCode: data.code,
    errorMessage: latestFailed.error?.message ?? '(no message)',
    ...(latestFailed.error?.stack ? { errorStack: latestFailed.error.stack } : {}),
    selectorPolicy: config.generation.selectorPolicy,
  });

  const customTools = createCaseTools({
    caseStore,
    defaultGeneration: data.generation,
    defaultSourceInput: data.source.input,
    defaultSourceType: 'generated',
  });

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

  const updateCall = result.toolCalls.find((c) => c.name === 'update_case');

  const out: HealResult = {
    ok: true,
    caseName,
    sourceRunId,
    durationMs,
    toolCalls: result.toolCalls.map((c) => ({
      name: c.name,
      input: c.input,
      isError: c.isError,
    })),
    content: result.content,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    logger.info(`修复完成 (${durationMs}ms)`);
    if (updateCall) {
      logger.info(`已调用 update_case 覆盖 ${caseName}`);
    } else {
      logger.warn('LLM 未调用 update_case，请检查输出');
    }
    if (result.content) {
      process.stdout.write('\n--- agent 输出 ---\n');
      process.stdout.write(result.content.trim() + '\n');
    }
  }

  return out;
}