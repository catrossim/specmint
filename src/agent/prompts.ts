/**
 * 生成用例的 prompt 模板
 *
 * 设计目标：
 * - 强约束风格（白/黑名单定位器、强制分层、中文注释）
 * - 暴露可用工具清单（与 typebox schema 同步），让 LLM 知道该如何落盘
 * - 探索模式注入 a11y snapshot + interactive elements 上下文
 * - 给出 SPEC 骨架参考，确保生成结果结构一致
 * - Few-shot：按场景匹配 example 注入，强化输出风格（v2）
 */
import { SPEC_TEMPLATE } from '../templates/spec.template.js';
import { PAGE_OBJECT_TEMPLATE } from '../templates/page-object.template.js';
import type { CaseGenerationMode, SelectorPolicy } from '../store/types.js';

/**
 * 内嵌示例库（few-shot）
 *
 * 设计动机：
 * - 直接把 examples/*.spec.ts 整文件塞进 prompt 会爆 token（每个 50~200 行）
 * - 真实经验：3 个完整 example ≈ 6000 tokens，每次 generate 都吃一次
 * - 这里抽"骨架"：保留风格信号（定位器用法、断言模式、命名分层），砍冗余分支
 *
 * 每个 example 必须遵守：
 * - import 标准化
 * - 演示至少一个白名单定位器
 * - 演示具体断言（不要只写 expect(...) 不写 matcher）
 * - 中文关键步骤注释
 *
 * 增加 example：往 EXAMPLE_LIBRARY 加键值对，并在 KEYWORDS 里登记触发词。
 */
export const EXAMPLE_LIBRARY: Record<string, string> = {
  'login-flow': `import { test, expect } from '@playwright/test';

test.describe('用户认证 · 登录流程', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
  });

  test('合法凭据登录成功并跳转首页', async ({ page }) => {
    // 语义定位器优先：label 与 input 已通过 htmlFor 关联
    await page.getByLabel('用户名').fill('admin');
    await page.getByLabel('密码').fill('admin123');
    await page.getByTestId('login-submit').click();
    // 等待跳转并断言落地页
    await expect(page).toHaveURL(/dashboard/);
    await expect(page.getByTestId('dashboard-title')).toHaveText('Dashboard');
  });

  test('错误密码显示用户名或密码错误', async ({ page }) => {
    await page.getByLabel('用户名').fill('admin');
    await page.getByLabel('密码').fill('wrong-password');
    await page.getByTestId('login-submit').click();
    // 错误提示通过 role=status + aria-live 暴露
    await expect(page.getByRole('status')).toHaveText('用户名或密码错误');
    await expect(page).toHaveURL(/login/);
  });
});`,

  'form-submit': `import { test, expect } from '@playwright/test';

test.describe('表单 · 提交', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: '新建订单' })).toBeVisible();
  });

  test('填写必填项后成功提交并展示成功提示', async ({ page }) => {
    // getByPlaceholder 适用于无 label 的次要字段
    await page.getByLabel('客户名称').fill('张三');
    await page.getByLabel('联系电话').fill('13800138000');
    await page.getByPlaceholder('备注').fill('请尽快处理');
    // 提交后用 getByRole 校验成功 toast
    await page.getByRole('button', { name: '提交' }).click();
    await expect(page.getByRole('status')).toHaveText('提交成功');
    await expect(page).toHaveURL(/orders\/\\d+/);
  });

  test('缺少必填字段时阻止提交并提示', async ({ page }) => {
    await page.getByLabel('客户名称').fill(''); // 故意留空
    await page.getByRole('button', { name: '提交' }).click();
    // 必填错误通过 aria-invalid + role=alert 暴露
    await expect(page.getByRole('alert')).toContainText('客户名称不能为空');
    await expect(page).toHaveURL(/orders\/new/);
  });
});`,

  'list-search': `import { test, expect } from '@playwright/test';

test.describe('列表 · 搜索筛选', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: '订单列表' })).toBeVisible();
  });

  test('输入关键词后列表仅展示命中项', async ({ page }) => {
    // 等待首屏加载完成（具体断言）
    await expect(page.getByTestId('order-row').first()).toBeVisible();
    // 搜索框用 getByPlaceholder（无 label 时回退）
    await page.getByPlaceholder('搜索订单号').fill('ORD-2024');
    // 触发搜索：表单 submit / 按钮 click / Enter 键皆可；这里演示 Enter
    await page.keyboard.press('Enter');
    // 断言每行都包含关键词
    const rows = page.getByTestId('order-row');
    await expect(rows.first()).toContainText('ORD-2024');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });
});`,

  'detail-page': `import { test, expect } from '@playwright/test';

test.describe('详情 · 展示', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/orders/123');
    await expect(page.getByRole('heading', { name: '订单详情' })).toBeVisible();
  });

  test('详情页正确展示订单基础信息', async ({ page }) => {
    // 用 getByText 验证关键字段值（非空）
    await expect(page.getByText('订单号: ORD-123')).toBeVisible();
    await expect(page.getByText('客户名称: 张三')).toBeVisible();
    await expect(page.getByText('金额: ¥198.00')).toBeVisible();
    // 操作按钮用 role
    await expect(page.getByRole('button', { name: '取消订单' })).toBeVisible();
  });
});`,
};

/**
 * 关键词索引：description 命中任一关键词就挑对应 example（首个匹配胜出）。
 * 关键词按"常见中文业务词 + 英文动作"覆盖：登录/表单/列表/搜索/详情/CRUD/...
 */
const EXAMPLE_KEYWORDS: Array<{ name: string; keywords: RegExp[] }> = [
  {
    name: 'login-flow',
    keywords: [/登录|login|登出|logout|认证|auth|注册|signup/i],
  },
  {
    name: 'list-search',
    keywords: [/搜索|search|筛选|filter|列表|list/i],
  },
  {
    name: 'detail-page',
    keywords: [/详情|detail|查看|view/i],
  },
  {
    name: 'form-submit',
    keywords: [/表单|form|提交|submit|新建|create|编辑|edit|更新/i],
  },
];

/**
 * 选 example。
 * - overrideName 指定时返回该 name 的内容（不存在抛错）
 * - 未指定时按关键词匹配第一个；未命中返回 null（不强制塞 example）
 *
 * 字段语义（与 CLI 选项对齐）：
 * - string：显式指定 example 名（必须存在于 EXAMPLE_LIBRARY）
 * - null | false：完全关闭 example 注入
 * - undefined：按 description 关键词自动匹配
 */
export function pickExample(
  description: string,
  overrideName?: string | null | false,
): { name: string; content: string } | null {
  if (overrideName === null || overrideName === false) return null;
  if (overrideName !== undefined) {
    const content = EXAMPLE_LIBRARY[overrideName];
    if (!content) {
      const available = Object.keys(EXAMPLE_LIBRARY).join(', ');
      throw new Error(
        `--example "${overrideName}" 不存在。可用: ${available}`,
      );
    }
    return { name: overrideName, content };
  }
  for (const { name, keywords } of EXAMPLE_KEYWORDS) {
    if (keywords.some((re) => re.test(description))) {
      return { name, content: EXAMPLE_LIBRARY[name]! };
    }
  }
  return null;
}

const TOOL_CATALOG = `
可用工具（通过 customTools 注册）：
- save_case(name, code, description, tags?, pageObject?, group?, module?, linkedTickets?):
  保存新用例到 tests/<name>.spec.ts + .meta.json。
  - name 推荐格式：<group>/<sub-name>（kebab-case），如 auth/login-success、profile/avatar-upload
  - group 可选：功能模块分组（kebab-case，如 "auth"）；与 name 前缀保持一致；CLI --group 传值时强制使用
  - module 可选：模块中文名（如 "用户认证"），CLI --module 传值时强制使用
  - linkedTickets 可选：关联 Jira / 需求单号列表（如 ["AUTH-123", "JIRA-456"]）
- update_case(name, code?, pageObject?, description?, tags?, group?, module?, linkedTickets?):
  更新已存在的用例
- list_cases(tag?, pattern?, priority?, module?, group?): 列出用例库
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

const CLASSIFY_RULES = `
用例归类规则（重要，所有用例都必须按功能模块归类）：
1. 你必须从"用户需求"中识别"功能模块"，并把分类信息写到 save_case 的 group / module 字段：
   - group  ：功能分组（kebab-case），对应物理子目录；例 auth / profile / orders / billing
   - module ：模块中文名，便于报告聚合展示；例 "用户认证" / "个人资料" / "订单管理"
2. 一旦确定 group：
   - name 必须以 "<group>/" 为前缀（例 auth/login-success），物理目录会落到 tests/auth/login-success.spec.ts
   - save_case 的 group 字段与 name 前缀保持完全一致
3. 若当前任务已经在某个用例名/前缀下（例如 update 流程），保持与该用例原有 group 一致
4. 如果需求里包含 Jira / 需求单号，填 linkedTickets（数组）
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
  /**
   * 可选：few-shot 示例（按 description 关键词自动匹配，或 CLI --example 显式指定）。
   * 注入到 SPEC 骨架之前，强化 LLM 的输出风格（白名单定位器、断言模式、命名分层）。
   */
  exampleContent?: { name: string; content: string } | null;
  /** CLI --module 显式传值；非空时 prompt 强约束 PI 原样使用 */
  cliModule?: string | null;
  /** CLI --group 显式传值；非空时 prompt 强约束 PI 原样使用 */
  cliGroup?: string | null;
  /**
   * 可选：前端元素契约（已渲染好的 XML 段）。
   * null/undefined = 无契约，跳过注入；非空时插在定位器策略段之后、pageObject 段之前。
   * 调用方负责契约加载与渲染（src/contract.ts），prompts.ts 不反向依赖契约模块。
   */
  contractSection?: string | null;
}

/**
 * 构造生成用例的 prompt
 */
export function buildGeneratePrompt(input: PromptInput): string {
  const parts: string[] = [];

  parts.push('你是 specmint 的 Playwright 用例生成助手。');
  parts.push(
    '任务：根据"用户需求"与上下文（如有）生成可读性好的 .spec.ts 源码，并通过工具调用直接落盘。',
  );
  parts.push('');

  parts.push(TOOL_CATALOG);
  parts.push(STYLE_RULES);
  parts.push(CLASSIFY_RULES);
  parts.push('');

  // Few-shot：在 SPEC 骨架之前注入一个匹配场景的参考样例。
  // 用 XML 标签包裹便于 LLM 区分"参考"与"骨架"。
  if (input.exampleContent) {
    parts.push(`<example name="${input.exampleContent.name}">`);
    parts.push('下面是匹配该场景的参考样例，请模仿：白名单定位器、断言模式、命名分层与注释风格。');
    parts.push('```ts');
    parts.push(input.exampleContent.content);
    parts.push('```');
    parts.push('</example>');
    parts.push('');
  }

  // CLI 显式指定 module / group 时：注入强约束段，强制 PI 原样使用
  const cliOverride =
    input.cliModule || input.cliGroup
      ? [
          'CLI 显式分类约束（强约束，必须遵守）：',
          `- module = "${input.cliModule ?? '(未指定)'}"`,
          `- group  = "${input.cliGroup ?? '(未指定)'}"`,
          '你必须在 save_case 中**原样**使用上述值，不得自行推断或改写。',
          input.cliGroup
            ? `name 必须以 "${input.cliGroup}/" 为前缀（如 ${input.cliGroup}/<sub-name>）。`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : null;
  if (cliOverride) {
    parts.push(cliOverride);
    parts.push('');
  }

  parts.push('定位器策略：');
  parts.push(`- 优先: ${input.selectorPolicy.prefer.join(', ')}`);
  parts.push(`- 避免: ${input.selectorPolicy.avoid.join(', ')}`);
  parts.push('');

  if (input.contractSection) {
    parts.push(input.contractSection);
    parts.push('');
  }

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
  parts.push(
    '2. 识别需求对应的功能模块，确定 group（kebab-case）与 module（中文）；CLI 已指定则原样使用',
  );
  parts.push(
    '3. 选择合适的用例名：格式 "<group>/<sub-name>"，如 auth/login-success（kebab-case，简洁反映场景）',
  );
  parts.push('4. 参考下方 SPEC 骨架填充源码');
  if (input.existingCaseName) {
    parts.push('5. 调用 update_case 工具一次性覆盖：name / code / 可选 pageObject（group 保持不变）');
  } else {
    parts.push('5. 调用 save_case 工具一次性落盘：');
    parts.push('   - name: "<group>/<sub-name>"（kebab-case，与 group 一致）');
    parts.push('   - code: 完整 .spec.ts 源码（含 import / describe / beforeEach / test）');
    parts.push('   - description: 复述原始需求');
    parts.push('   - group: 与 name 前缀一致（CLI --group 显式传值时原样使用）');
    parts.push('   - module: 模块中文名（CLI --module 显式传值时原样使用）');
    if (input.pageObjectEnabled) {
      parts.push(
        '   - pageObject: { file: "./pages/<sub-name>.page.ts", code: "..." }',
      );
      parts.push('');
      parts.push(
        '【路径与扩展名硬约束 - 必须严格遵守，否则运行时无法解析 POM】',
      );
      parts.push(
        '- 本用例的 spec.ts 实际位于 <casesDir>/<group>/<sub>.spec.ts（在 group 子目录下）',
      );
      parts.push(
        '- POM 实际位于 <casesDir>/pages/<sub>.page.ts（位于 casesDir/pages/）',
      );
      parts.push(
        '- 因此 spec.ts 中必须用 "相对自身" 路径 import POM，形如：',
      );
      parts.push("      import { FooPage } from '../pages/<sub-name>.page.ts';");
      parts.push(
        '- 必须带 `.ts` 后缀（ESM 模式下 Node 模块解析强制要求完整扩展名，Playwright 不会自动补）',
      );
      parts.push(
        '- 严禁写成 "./pages/..." 或无扩展名 "./pages/<sub>.page"，会在运行时报',
      );
      parts.push(
        '      Error: Cannot find module ".../<sub>.page" imported from .../<group>/<sub>.spec.ts',
      );
    }
    if (input.cliModule || input.cliGroup) {
      parts.push('   注意：CLI 已显式指定 module / group，请原样使用不要改写');
    }
  }
  parts.push('6. 调用工具成功后，简短输出用例名 + 2-3 句设计意图');
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
  parts.push('你是 specmint 的用例修复助手。');
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
  parts.push(
    '3. 保持原用例的 group / module / linkedTickets 不变，仅提交 name + code（update_case 不传这两个字段）',
  );
  parts.push('4. 调用 update_case 工具提交修复后的 name + code');
  parts.push('5. 输出修复要点（1-2 句）');
  return parts.join('\n');
}export interface SetupPromptInput {
  description: string;
  name: string;
  url: string | null;
  storageStateRel: string;
}

export function buildGenerateSetupPrompt(input: SetupPromptInput): string {
  return [
    '你是 specmint 的 auth setup 生成助手。',
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

/**
 * 轻量分类 prompt：用于交互式确认流程（--interactive）
 *
 * 目的：在 LLM 真正跑用例之前，先低成本推断"元信息"（module/group/caseName/摘要），
 * 让用户在生成前快速确认/修改，避免 LLM 跑完用例后才发现 group 不对。
 *
 * 不调用任何工具，纯文本返回。调用方负责解析 JSON。
 */
export interface ClassifyInput {
  description: string;
}

export interface ClassifyOutput {
  module: string;       // 中文模块名（≤ 8 字）
  group: string;        // kebab-case 英文分组
  caseName: string;     // 形如 "<group>/<sub-name>"
  summary: string;      // 1~2 句中文摘要
}

export function buildClassifyPrompt(input: ClassifyInput): string {
  return [
    '你是 specmint 的用例元信息分类助手。',
    '任务：根据"用户需求"推断 4 个字段：module / group / caseName / summary。',
    '',
    '约束：',
    '- module: 中文模块名（≤ 8 字），如 "用户认证"、"订单管理"',
    '- group:  kebab-case 英文分组（仅小写字母/数字/连字符），如 "auth"、"order-list"',
    '- caseName: 形如 "<group>/<sub-name>"（如 "auth/login-success"），sub-name 也用 kebab-case',
    '- summary: 1~2 句中文摘要，说明用例覆盖的场景',
    '',
    '输出格式（仅输出 JSON，不要任何额外文本 / Markdown 围栏）：',
    '{"module":"...","group":"...","caseName":"...","summary":"..."}',
    '',
    '用户需求：' + input.description.trim(),
  ].join('\n');
}