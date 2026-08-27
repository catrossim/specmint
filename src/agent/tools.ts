/**
 * 注入给 pi-agent 的用例库工具（基于 SDK defineTool）
 *
 * SDK 文档：
 * - defineTool({ name, label, description, parameters: Type.Object(...), execute })
 * - parameters 必须用 typebox schema
 * - execute 签名: async (toolCallId, params) => { content: [{type:'text', text}], details }
 */
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { CaseStore } from '../store/case-store.js';
import type {
  CaseGenerationMode,
  CaseSummary,
  CaseWithCode,
  SelectorPolicy,
} from '../store/types.js';
import { CliError } from '../utils/errors.js';

export interface CaseToolsContext {
  caseStore: CaseStore;
  defaultGeneration: {
    mode: CaseGenerationMode;
    model: string;
    exploredUrl: string | null;
    selectorPolicy: SelectorPolicy;
  };
  defaultSourceInput: string;
  defaultSourceType: 'generated';
}

// --- typebox 参数 schema ---

const SaveCaseParams = Type.Object({
  name: Type.String({
    description: 'kebab-case 用例名，如 "login-success"',
  }),
  code: Type.String({
    description: '完整 .spec.ts 源码（含 import / describe / beforeEach / test）',
  }),
  description: Type.String({
    description: '原始需求描述',
  }),
  tags: Type.Optional(
    Type.Array(Type.String(), { description: '可选标签列表' }),
  ),
  pageObject: Type.Optional(
    Type.Object(
      {
        file: Type.String({
          description: '相对 casesDir 的 POM 路径，如 "./pages/login.page.ts"',
        }),
        code: Type.String({ description: '完整 POM 源码' }),
      },
      { description: '可选 Page Object（仅 --page-object 模式）' },
    ),
  ),
});

const UpdateCaseParams = Type.Object({
  name: Type.String({ description: '要更新的用例名' }),
  code: Type.Optional(Type.String({ description: '可选，覆盖 spec 源码' })),
  pageObject: Type.Optional(
    Type.Object({
      file: Type.String(),
      code: Type.String(),
    }),
  ),
  description: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
});

const ListCasesParams = Type.Object({
  tag: Type.Optional(Type.String({ description: '按 tag 过滤' })),
  pattern: Type.Optional(Type.String({ description: '按 name 子串过滤' })),
});

const ReadCaseParams = Type.Object({
  name: Type.String({ description: '用例名' }),
});

// --- 工具返回结构 ---

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

function okResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, ...payload }) }],
    details: {},
  };
}

function errorResult(tool: string, err: unknown): ToolResult {
  let message: string;
  if (err instanceof CliError) {
    message = `[${tool}] ${err.message}${err.hint ? ` (${err.hint})` : ''}`;
  } else {
    message = `[${tool}] ${err instanceof Error ? err.message : String(err)}`;
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }],
    details: {},
  };
}

// --- 工具工厂 ---

/**
 * 构造 4 个 CaseStore 工具（save_case / update_case / list_cases / read_case）
 */
export function createCaseTools(ctx: CaseToolsContext): ToolDefinition[] {
  return [
    defineTool({
      name: 'save_case',
      label: 'Save Case',
      description:
        '保存一个新用例到 tests/<name>.spec.ts + <name>.meta.json；已存在同名用例会报错。',
      parameters: SaveCaseParams,
      execute: async (_toolCallId, params) => {
        try {
          const result = ctx.caseStore.save(
            {
              name: params.name,
              description: params.description,
              tags: params.tags,
              source: {
                type: ctx.defaultSourceType,
                input: ctx.defaultSourceInput,
              },
              generation: ctx.defaultGeneration,
              pageObject: params.pageObject
                ? {
                    enabled: true,
                    file: params.pageObject.file,
                    code: params.pageObject.code,
                  }
                : undefined,
            },
            params.code,
          );
          return okResult({
            specPath: result.specPath,
            metaPath: result.metaPath,
            message: `用例 ${params.name} 已保存`,
          });
        } catch (err) {
          return errorResult('save_case', err);
        }
      },
    }),

    defineTool({
      name: 'update_case',
      label: 'Update Case',
      description:
        '更新已存在的用例：覆盖 spec / POM 代码或修改 meta 字段（description / tags）。',
      parameters: UpdateCaseParams,
      execute: async (_toolCallId, params) => {
        try {
          if (params.code !== undefined) {
            ctx.caseStore.updateCode(params.name, params.code, params.pageObject);
          } else if (params.pageObject) {
            const current = ctx.caseStore.readSpec(params.name);
            ctx.caseStore.updateCode(params.name, current, params.pageObject);
          }
          const patch: Record<string, unknown> = {};
          if (params.description !== undefined) patch.description = params.description;
          if (params.tags !== undefined) patch.tags = params.tags;
          if (Object.keys(patch).length > 0) {
            ctx.caseStore.updateMeta(params.name, patch);
          }
          return okResult({
            specPath: ctx.caseStore.specPath(params.name),
            metaPath: ctx.caseStore.metaPath(params.name),
            message: `用例 ${params.name} 已更新`,
          });
        } catch (err) {
          return errorResult('update_case', err);
        }
      },
    }),

    defineTool({
      name: 'list_cases',
      label: 'List Cases',
      description: '列出用例库中的用例摘要，支持按 tag 与 name 子串过滤。',
      parameters: ListCasesParams,
      execute: async (_toolCallId, params) => {
        const items = ctx.caseStore.list({
          tag: params.tag,
          pattern: params.pattern,
        });
        return okResult({ count: items.length, items });
      },
    }),

    defineTool({
      name: 'read_case',
      label: 'Read Case',
      description:
        '读取用例完整内容（含 spec 与 POM 代码），供读后改写或理解结构。',
      parameters: ReadCaseParams,
      execute: async (_toolCallId, params) => {
        const data = ctx.caseStore.readWithCode(params.name);
        if (!data) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ ok: false, error: `用例 ${params.name} 不存在` }),
              },
            ],
            details: {},
          };
        }
        return okResult({ case: data });
      },
    }),
  ];
}

/**
 * 工具名常量集合（用于 generate / heal 处组装 tools allowlist）
 */
export const CASE_TOOL_NAMES = ['save_case', 'update_case', 'list_cases', 'read_case'] as const;

// 重新导出供 generate/heal 引用
export type { ToolDefinition };