/**
 * 生成用例的 prompt 模板
 *
 * 设计目标：
 * - 强约束风格（白/黑名单定位器、强制分层、中文注释）
 * - 暴露可用工具清单（与 typebox schema 同步），让 LLM 知道该如何落盘
 * - 探索模式注入 a11y snapshot + interactive elements 上下文
 * - 给出 SPEC 骨架参考，确保生成结果结构一致
 */
import { SPEC_TEMPLATE } from '../templates/spec.template.js';
import { PAGE_OBJECT_TEMPLATE } from '../templates/page-object.template.js';
import type { CaseGenerationMode, SelectorPolicy } from '../store/types.js';

const TOOL_CATALOG = `
可用工具（通过 customTools 注册）：
- save_case(name, code, description, tags?, pageObject?): 保存新用例到 tests/<name>.spec.ts + .meta.json
- update_case(name, code?, pageObject?, description?, tags?): 更新已存在的用例
- list_cases(tag?, pattern?): 列出用例库
- read_case(name): 读取用例完整内容（含 spec 与 POM 代码）
`;

const STYLE_RULES = `
风格约束（强约束，违反将被 reject）：
1. import 必须为: import { test, expect } from '@playwright/test'; 禁止引入其他断言库
2. 优先语义定位器（白名单）：getByRole / getByLabel / getByPlaceholder / getByTestId / getByText
3. 禁止易碎选择器（黑名单）：nth-child / nth-of-type / 复杂 CSS / XPath
4. 必须用 test.describe 分组，test.beforeEach 设置前置条件
5. 每个独立场景拆分为独立 test()
6. 关键步骤追加中文注释说明意图
7. 不要写 await page.waitForTimeout() 这类固定等待（除非必须并标注原因）
8. await expect(...) 必须指定具体断言（toBeVisible / toHaveText / toHaveURL 等）
9. 不写 console.log / debugger / 临时调试代码
`;

export interface PromptInput {
  description: string;
  mode: CaseGenerationMode;
  selectorPolicy: SelectorPolicy;
  exploredUrl?: string | null;
  pageObjectEnabled: boolean;
  defaultPriority: 'P0' | 'P1' | 'P2' | 'P3';
  /** 仅 explore-assisted 模式 */
  accessibilitySnapshot?: string;
  /** 仅 explore-assisted 模式 */
  interactiveElements?: string;
  /** 可选：已知用例名（用于 update 流程） */
  existingCaseName?: string;
}

/**
 * 构造生成用例的 prompt
 */
export function buildGeneratePrompt(input: PromptInput): string {
  const parts: string[] = [];

  parts.push('你是 auto-test 的 Playwright 用例生成助手。');
  parts.push(
    '任务：根据"用户需求"与上下文（如有）生成可读性好的 .spec.ts 源码，并通过工具调用直接落盘。',
  );
  parts.push('');

  parts.push(TOOL_CATALOG);
  parts.push(STYLE_RULES);
  parts.push('');

  parts.push('定位器策略：');
  parts.push(`- 优先: ${input.selectorPolicy.prefer.join(', ')}`);
  parts.push(`- 避免: ${input.selectorPolicy.avoid.join(', ')}`);
  parts.push('');

  if (input.pageObjectEnabled) {
    parts.push('本任务需要同步生成 Page Object 文件（--page-object 模式）。');
    parts.push('POM 骨架参考：');
    parts.push('```ts');
    parts.push(PAGE_OBJECT_TEMPLATE);
    parts.push('```');
    parts.push('');
  }

  if (input.mode === 'explore-assisted') {
    parts.push(
      `已为目标 URL ${input.exploredUrl ?? ''} 提取 a11y 快照与可交互元素，请基于实际页面结构生成用例：`,
    );
    parts.push('');
    parts.push('<accessibility-snapshot>');
    parts.push(input.accessibilitySnapshot?.trim() || '(空)');
    parts.push('</accessibility-snapshot>');
    if (input.interactiveElements && input.interactiveElements.trim().length > 0) {
      parts.push('');
      parts.push('<interactive-elements>');
      parts.push(input.interactiveElements);
      parts.push('</interactive-elements>');
    }
    parts.push('');
  }

  if (input.existingCaseName) {
    parts.push(`已有同名用例：${input.existingCaseName}`);
    parts.push('请使用 update_case 覆盖更新（保留 tags 仅在显式传入时修改）。');
    parts.push('');
  }

  parts.push('用户需求：');
  parts.push(input.description.trim());
  parts.push('');

  parts.push('执行步骤：');
  parts.push('1. 阅读风格约束、定位器策略与上下文（探索模式）');
  parts.push('2. 选择合适的用例名（kebab-case，简洁且反映场景）');
  parts.push('3. 参考下方 SPEC 骨架填充源码');
  if (input.existingCaseName) {
    parts.push('4. 调用 update_case 工具一次性覆盖：name / code / 可选 pageObject');
  } else {
    parts.push('4. 调用 save_case 工具一次性落盘：');
    parts.push('   - name: kebab-case 字符串');
    parts.push('   - code: 完整 .spec.ts 源码（含 import / describe / beforeEach / test）');
    parts.push('   - description: 复述原始需求');
    if (input.pageObjectEnabled) {
      parts.push('   - pageObject: { file: "./pages/<name>.page.ts", code: "..." }');
    }
  }
  parts.push('5. 调用工具成功后，简短输出用例名 + 2-3 句设计意图');
  parts.push('');

  parts.push('SPEC 骨架参考：');
  parts.push('```ts');
  parts.push(SPEC_TEMPLATE);
  parts.push('```');

  return parts.join('\n');
}

/**
 * 构造 heal（自动修复）prompt
 *
 * 把失败用例 + 错误日志交给 LLM，让它用 update_case 工具覆盖。
 */
export function buildHealPrompt(input: {
  caseName: string;
  specCode: string;
  errorMessage: string;
  errorStack?: string;
  selectorPolicy: SelectorPolicy;
}): string {
  const parts: string[] = [];
  parts.push('你是 auto-test 的用例修复助手。');
  parts.push(
    '任务：分析失败用例的代码与错误日志，用 update_case 工具覆盖修复。',
  );
  parts.push('');
  parts.push(STYLE_RULES);
  parts.push('');
  parts.push('定位器策略：');
  parts.push(`- 优先: ${input.selectorPolicy.prefer.join(', ')}`);
  parts.push(`- 避免: ${input.selectorPolicy.avoid.join(', ')}`);
  parts.push('');
  parts.push(`用例名：${input.caseName}`);
  parts.push('');
  parts.push('当前 spec.ts 源码：');
  parts.push('```ts');
  parts.push(input.specCode);
  parts.push('```');
  parts.push('');
  parts.push('错误信息：');
  parts.push('```');
  parts.push(input.errorMessage);
  if (input.errorStack) parts.push(input.errorStack);
  parts.push('```');
  parts.push('');
  parts.push('执行步骤：');
  parts.push('1. 分析失败原因：是选择器漂移、等待不足、断言错误，还是产品行为变更');
  parts.push('2. 修改 spec.ts，使用更稳健的定位器 / 等待策略');
  parts.push('3. 调用 update_case 工具提交修复后的 name + code');
  parts.push('4. 输出修复要点（1-2 句）');
  return parts.join('\n');
}export interface SetupPromptInput {
  description: string;
  name: string;
  url: string | null;
  storageStateRel: string;
}

export function buildGenerateSetupPrompt(input: SetupPromptInput): string {
  return [
    '你是 auto-test 的 auth setup 生成助手。',
    '任务：为 ' + input.name + ' 角色生成 setup.ts',
    '登录页：' + (input.url ?? '从描述推断'),
    'storageState：' + input.storageStateRel,
    '',
    '约束：',
    '- import: test as setup, expect',
    '- 密码从 process.env 读取',
    '- 末尾 storageState 调用',
    '',
    '用户描述：' + input.description,
  ].join('\n');
}