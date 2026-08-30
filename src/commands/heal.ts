/**
 * heal 子命令：自动修复失败用例
 *
 * 流程：
 *   1. 读取用例 spec + meta
 *   2. 查找最近一次失败记录（错误信息、stack）
 *   3. P1：verdict 卡口（默认仅 needs-fix 可被 heal；--include-* / --force / --no-require-review 放宽）
 *   4. 构造 heal prompt
 *   5. pi-agent 调用 update_case 工具覆盖修复
 *   6. 输出修复结果 + review show 链接
 */
import { createStores } from '../store/index.js';
import { loadConfig } from '../config.js';
import { CliError, ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { createAgentSession } from '../agent/session.js';
import { createCaseTools, CASE_TOOL_NAMES } from '../agent/tools.js';
import { buildHealPrompt } from '../agent/prompts.js';
import type { ReviewVerdict, TestResult } from '../store/types.js';

export interface HealOptions {
  from?: string;
  json?: boolean;
  /** P1：review verdict 卡口标志（与 config.review 段叠加生效） */
  includePending?: boolean;
  includeApproved?: boolean;
  includeRejected?: boolean;
  /** 强制跳过 verdict 检查；忽略 verdict 并继续 */
  force?: boolean;
  /** 关闭 verdict 卡口（等价 requireBeforeHeal=false） */
  noRequireReview?: boolean;
}

export interface HealResult {
  ok: boolean;
  caseName: string;
  sourceRunId: string | null;
  durationMs: number;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; isError?: boolean }>;
  content: string;
}

/** P1：heal 默认仅 verdict=needs-fix 可被 heal；与 config.review.blockedOnHeal 叠加 */
const DEFAULT_HEAL_BLOCKED: ReviewVerdict[] = ['pending', 'approved', 'rejected', 'skipped'];

export async function healCommand(
  caseName: string,
  options: HealOptions,
): Promise<HealResult> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const { caseStore, historyStore } = createStores(cwd);

  const data = caseStore.readWithCode(caseName);
  if (!data) {
    throw new CliError({ code: ExitCode.NOT_FOUND, message: `用例 ${caseName} 不存在` });
  }

  // P1：verdict 卡口（与 run.ts 的卡口语义对齐：默认仅放行 needs-fix）
  const reviewCfg = config.review;
  const currentVerdict = (data.review?.verdict ?? 'pending') as ReviewVerdict;
  const gateEnabled =
    !!reviewCfg?.requireBeforeHeal && !options.noRequireReview && !options.force;
  if (gateEnabled) {
    const blocked = new Set<ReviewVerdict>(
      reviewCfg!.blockedOnHeal?.length ? reviewCfg!.blockedOnHeal : DEFAULT_HEAL_BLOCKED,
    );
    if (options.includePending) blocked.delete('pending');
    if (options.includeApproved) blocked.delete('approved');
    if (options.includeRejected) blocked.delete('rejected');
    if (blocked.has(currentVerdict)) {
      throw new CliError({
        code: ExitCode.NOT_FOUND,
        message: `用例 ${caseName} 当前 verdict=${currentVerdict}，已被 heal 卡口过滤`,
        hint: `用 --include-pending / --include-approved / --include-rejected 放宽，或 --force 关闭卡口\n查看裁决状态：specmint review show ${caseName}\n批量裁决：specmint review`,
      });
    }
    if (currentVerdict !== 'needs-fix' && !options.json) {
      logger.warn(
        `[heal] ${caseName} verdict=${currentVerdict}（非 needs-fix 但已通过过滤，仍执行）`,
      );
    }
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
      hint: '先用 `specmint run` 触发一次运行并产生失败',
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
    // heal 沿用 meta 中已存的 priority 作为兜底；update_case 工具中未传时不强制要求
    defaultPriority: data.priority ?? 'P1',
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
    if (!options.json) {
      // P1：修复后提示重新裁决（verdict=needs-fix 才能继续被 heal，但修复后状态仍可能是 needs-fix，需 review 重标 approved 或 needs-fix）
      logger.info('');
      logger.info('下一步：');
      logger.info(`  specmint review show ${caseName}    # 查看当前裁决状态`);
      logger.info(`  specmint review set ${caseName} --verdict approved   # 标 approved（已通过验收）`);
      logger.info(`  specmint review set ${caseName} --verdict needs-fix  # 仍需继续修复`);
    }
  }

  return out;

}
