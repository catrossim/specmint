/**
 * pi-coding-agent SDK 封装（基于 @earendil-works/pi-coding-agent）
 *
 * 关键适配点（基于官方 SDK 文档 https://pi.dev/docs/latest/sdk）：
 * - 包名：@earendil-works/pi-coding-agent（不是 @mariozechner/...）
 * - 凭证：ModelRuntime.create()（无 AuthStorage；落 ~/.pi/agent/auth.json）
 * - 会话：createAgentSession({customTools, tools, sessionManager, modelRuntime, model})
 * - 事件：session.subscribe(listener)，事件 type 是 AgentSessionEvent 联合
 * - prompt() 返回 Promise<void>，输出走 message_update 事件流
 * - 工具调用：tool_execution_start / tool_execution_end 事件携带工具名与参数
 * - 释放：session.dispose()
 */
import {
  ModelRuntime,
  SessionManager,
  createAgentSession as sdkCreateAgentSession,
  defineTool,
  type AgentSession as SdkAgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { CliError, ExitCode } from '../utils/errors.js';

export interface AgentSessionConfig {
  /** 形如 "anthropic/claude-sonnet-latest" */
  model?: string;
  /** 通过 defineTool() 定义的自定义工具 */
  customTools?: ToolDefinition[];
  /** 工具 allowlist：customTools 的名字必须列入才能启用 */
  toolsAllowlist?: string[];
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  cwd?: string;
  /** 工具调用开始时的回调（用于进度反馈） */
  onToolCall?: (event: { name: string; input: Record<string, unknown> }) => void;
  /** 流式文本回调 */
  onText?: (delta: string) => void;
}

export interface AgentToolCallEvent {
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
  isError: boolean;
}

export interface AgentPromptResult {
  toolCalls: AgentToolCallEvent[];
  content: string;
  messageCount: number;
}

export interface AgentSession {
  prompt(text: string): Promise<AgentPromptResult>;
  dispose(): Promise<void>;
}

/**
 * 解析 modelId 到 Model
 *
 * 支持：
 * - "provider/model" 形式 → getModel(provider, modelId)
 * - 仅 "provider" 形式 → getModels(provider)[0]（自动选该 provider 下第一个模型）
 * - 省略 modelId → getAvailable()[0]（自动选第一个已配置 auth 的模型）
 */
async function resolveModel(
  modelRuntime: Awaited<ReturnType<typeof ModelRuntime.create>>,
  modelId: string | undefined,
) {
  // 全部省略：选第一个可用 model
  if (!modelId) {
    const available = await modelRuntime.getAvailable();
    if (available.length === 0) {
      throw new CliError({
        code: ExitCode.AGENT_ERROR,
        message: '无可用模型（~/.pi/agent/auth.json 未配置任何 provider）',
        hint: '先在 pi-agent 中配置 API Key',
      });
    }
    return available[0];
  }

  const slashIdx = modelId.indexOf('/');
  if (slashIdx < 0) {
    // 仅 provider，自动选第一个 model
    const provider = modelId;
    const models = modelRuntime.getModels(provider);
    if (models.length === 0) {
      throw new CliError({
        code: ExitCode.AGENT_ERROR,
        message: `provider "${provider}" 没有可用模型`,
        hint: '检查 ~/.pi/agent/auth.json 是否配置了该 provider',
      });
    }
    return models[0];
  }

  const provider = modelId.slice(0, slashIdx);
  const id = modelId.slice(slashIdx + 1);
  const model = modelRuntime.getModel(provider, id);
  if (!model) {
    throw new CliError({
      code: ExitCode.AGENT_ERROR,
      message: `模型 ${modelId} 不可用或未配置`,
      hint: '检查 ~/.pi/agent/auth.json 是否配置了该 provider 的 API Key',
    });
  }
  return model;
}

export async function createAgentSession(
  config: AgentSessionConfig,
): Promise<AgentSession> {
  // 1. ModelRuntime（凭证管理）
  const modelRuntime = await ModelRuntime.create().catch((err) => {
    throw new CliError({
      code: ExitCode.AGENT_ERROR,
      message: `创建 ModelRuntime 失败：${(err as Error).message}`,
      hint: '请确认 ~/.pi/agent/auth.json 存在并配置了 API Key',
    });
  });

  const model = await resolveModel(modelRuntime, config.model);

  // 2. 工具 allowlist：customTools 的名字必须列入
  const customToolNames = (config.customTools ?? []).map((t) => t.name);
  const toolsAllowlist = config.toolsAllowlist ?? customToolNames;

  // 3. 创建 session
  const sdkResult = await sdkCreateAgentSession({
    cwd: config.cwd ?? process.cwd(),
    modelRuntime,
    ...(model ? { model } : {}),
    ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
    sessionManager: SessionManager.inMemory(),
    customTools: config.customTools ?? [],
    tools: toolsAllowlist,
  }).catch((err) => {
    throw new CliError({
      code: ExitCode.AGENT_ERROR,
      message: `创建 pi-agent session 失败：${(err as Error).message}`,
    });
  });

  const session: SdkAgentSession = sdkResult.session;

  // 4. 事件订阅器：累积工具调用 + 文本流
  let toolCalls: AgentToolCallEvent[] = [];
  let contentParts: string[] = [];
  let capturing = false;

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (!capturing) return;
    handleEvent(event, toolCalls, contentParts, config);
  });

  return {
    prompt: async (text: string) => {
      capturing = true;
      toolCalls = [];
      contentParts = [];
      try {
        await session.prompt(text);
      } finally {
        capturing = false;
      }
      return {
        toolCalls: toolCalls.slice(),
        content: contentParts.join(''),
        messageCount: session.messages.length,
      };
    },
    dispose: async () => {
      try {
        session.dispose();
      } finally {
        unsubscribe();
      }
    },
  };
}

/**
 * 处理 AgentSessionEvent：累积工具调用与文本流
 *
 * AgentSessionEvent 形态来自 SDK 文档：
 * - message_update: { assistantMessageEvent: { type: 'text_delta' | 'thinking_delta' | ..., delta } }
 * - tool_execution_start: { toolName, toolCallId, args }
 * - tool_execution_end: { toolName, toolCallId, result, isError }
 *
 * 注意：SDK 跨版本字段名可能略有差异，这里做宽松适配。
 */
function handleEvent(
  event: AgentSessionEvent,
  toolCalls: AgentToolCallEvent[],
  contentParts: string[],
  config: AgentSessionConfig,
): void {
  const e = event as unknown as Record<string, unknown>;

  switch (event.type) {
    case 'message_update': {
      const inner = (e['assistantMessageEvent'] ?? {}) as Record<string, unknown>;
      if (inner['type'] === 'text_delta' && typeof inner['delta'] === 'string') {
        contentParts.push(inner['delta']);
        config.onText?.(inner['delta']);
      }
      break;
    }
    case 'tool_execution_start': {
      const toolName = typeof e['toolName'] === 'string' ? e['toolName'] : 'unknown';
      const args = (e['args'] ?? {}) as Record<string, unknown>;
      toolCalls.push({ name: toolName, input: args, isError: false });
      config.onToolCall?.({ name: toolName, input: args });
      break;
    }
    case 'tool_execution_end': {
      // 找到最后一次匹配的 toolCall，更新 result
      const toolName = typeof e['toolName'] === 'string' ? e['toolName'] : null;
      const isError = !!e['isError'];
      const result = e['result'];
      for (let i = toolCalls.length - 1; i >= 0; i--) {
        const c = toolCalls[i]!;
        if (toolName === null || c.name === toolName) {
          c.result = result;
          c.isError = isError;
          break;
        }
      }
      break;
    }
    default:
      // 其他事件类型忽略（agent_start/end, turn_start/end, message_start/end 等）
      break;
  }
}

// 重新导出 defineTool 以便 tools.ts 复用
export { defineTool };