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
  CaseGeneration,
  CaseGenerationMode,
  CaseWithCode,
  Priority,
  SelectorPolicy,
} from '../store/types.js';
import { PRIORITIES } from '../store/types.js';
import { CliError } from '../utils/errors.js';

export interface CaseToolsContext {
  caseStore: CaseStore;
  defaultGeneration: Omit<CaseGeneration, never>;
  defaultSourceInput: string;
  defaultSourceType: 'generated';
  /** generate 命令行 --priority 参数，作为 priority 字段缺失时的兜底 */
  defaultPriority: Priority;
  /**
   * generate 命令行 --module 参数。
   * - 非空时：save_case 强制覆盖 PI 输入的 module 字段
   * - 未传时：允许 PI 自由推断
   */
  defaultModule?: string;
  /**
   * generate 命令行 --group 参数（kebab-case）。
   * - 非空时：save_case 强制覆盖 PI 输入的 group 字段并校验 name 前缀一致
   * - 未传时：允许 PI 自由推断
   */
  defaultGroup?: string;
}

// --- typebox 参数 schema ---

const PriorityEnum = Type.Union(
  PRIORITIES.map((p) => Type.Literal(p)),
  { description: `用例优先级（必须是 ${PRIORITIES.join('|')} 之一）` },
);

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
  // priority 不暴露给 PI：必须与 CLI --priority 一致（CLI 是 defaultPriority 兜底）
  // 在 save_case.execute 内部强制用 ctx.defaultPriority 覆盖 PI 任何传值
  // priority 不暴露给 PI：必须与 CLI --priority 一致（CLI 是 defaultPriority 兜底）
  // 在 save_case.execute 内部强制用 ctx.defaultPriority 覆盖 PI 任何传值
  tags: Type.Optional(
    Type.Array(Type.String(), { description: '可选标签列表（小写 kebab-case）' }),
  ),
  group: Type.Optional(
    Type.String({ description: '可选功能模块分组（kebab-case），如 "auth"' }),
  ),
  module: Type.Optional(
    Type.String({ description: '可选模块中文名，如 "用户认证"' }),
  ),
  linkedTickets: Type.Optional(
    Type.Array(Type.String(), { description: '可选关联 Jira / 需求单号' }),
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
  priority: Type.Optional(PriorityEnum),
  tags: Type.Optional(Type.Array(Type.String())),
  group: Type.Optional(Type.String()),
  module: Type.Optional(Type.String()),
  linkedTickets: Type.Optional(Type.Array(Type.String())),
});

const ListCasesParams = Type.Object({
  tag: Type.Optional(Type.String({ description: '按 tag 过滤' })),
  pattern: Type.Optional(Type.String({ description: '按 name 子串过滤' })),
  priority: Type.Optional(PriorityEnum),
  module: Type.Optional(
    Type.String({ description: '按模块中文名过滤（精确匹配 meta.module）' }),
  ),
  group: Type.Optional(
    Type.String({ description: '按功能模块分组过滤（kebab-case，匹配 meta.group 或 name 前缀）' }),
  ),
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
        '保存一个新用例到 tests/<name>.spec.ts + <name>.meta.json；已存在同名用例会报错。' +
        '若 name 含 "<group>/" 前缀则物理目录与 meta.group 都按 group 写入。' +
        'CLI --module/--group 会强制覆盖 PI 输入的 module / group 字段。',
      parameters: SaveCaseParams,
      execute: async (_toolCallId, params) => {
        try {
          // CLI --group / --module 强制覆盖 PI 输入
          const group = ctx.defaultGroup ?? params.group;
          const module = ctx.defaultModule ?? params.module;

          // 当 CLI 指定了 group 但 PI 提供的 name 没带前缀时，自动加上前缀以保持物理目录一致
          let name = params.name;
          if (group && !name.includes('/')) {
            name = `${group}/${name}`;
          }

          const result = ctx.caseStore.save(
            {
              name,
              description: params.description,
              priority: ctx.defaultPriority, // CLI --priority 强制覆盖 PI 输入
              tags: params.tags,
              group,
              module,
              linkedTickets: params.linkedTickets,
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
            message: `用例 ${name} 已保存`,
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
          if (params.priority !== undefined) patch.priority = params.priority;
          if (params.tags !== undefined) patch.tags = params.tags;
          if (params.group !== undefined) patch.group = params.group;
          if (params.module !== undefined) patch.module = params.module;
          if (params.linkedTickets !== undefined) patch.linkedTickets = params.linkedTickets;
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
      description:
        '列出用例库中的用例摘要，支持按 tag、name 子串、priority、module、group 过滤。',
      parameters: ListCasesParams,
      execute: async (_toolCallId, params) => {
        const items = ctx.caseStore.list({
          tag: params.tag,
          pattern: params.pattern,
          priority: params.priority,
          module: params.module,
          group: params.group,
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

// --- save_setup（auth generate 专用）---

const SaveSetupParams = Type.Object({
  name: Type.String({ description: 'auth name（kebab-case），对应文件名 <name>.setup.ts' }),
  code: Type.String({ description: '完整 .setup.ts 源码（以 import { test as setup, expect } from "@playwright/test" 开头，必须在末尾调用 page.context().storageState({ path })）' }),
  url: Type.Optional(Type.String({ description: '登录页 URL（用于 prompt 上下文）' })),
});

export interface SetupToolsContext {
  /** auth setup 目录绝对路径（.auto-test/auth） */
  authDir: string;
  /** storage 文件绝对路径（.auto-test/auth/storage/<name>.json） */
  storageStateAbs: string;
  /** PI 推断的登录 URL（写进 meta） */
  url?: string;
}

export function createSetupTools(ctx: SetupToolsContext): ToolDefinition[] {
  return [
    defineTool({
      name: 'save_setup',
      label: 'Save Setup',
      description:
        '保存 setup 文件到 .auto-test/auth/<name>.setup.ts，并在末尾自动调用 storageState。',
      parameters: SaveSetupParams,
      execute: async (_toolCallId, params) => {
        try {
          const setupPath = join(ctx.authDir, `${params.name}.setup.ts`);
          ensureDir(ctx.authDir);
          writeFileSync(setupPath, params.code, 'utf-8');
          return okResult({
            setupPath,
            storageState: ctx.storageStateAbs,
            message: `setup ${params.name} 已保存到 ${setupPath}`,
          });
        } catch (err) {
          return errorResult('save_setup', err);
        }
      },
    }),
  ];
}

export const SETUP_TOOL_NAMES = ['save_setup'] as const;

// --- 工具需要的 imports ---

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

// 重新导出供 generate/heal 引用
export type { ToolDefinition };