/**
 * 用例脚本模板
 *
 * 这是一份给 pi-agent 看的"骨架+风格约束"，由 agent 在生成阶段填充占位符。
 * 占位符语义：{{...}} 必须保持，否则模板渲染逻辑会失败。
 *
 * 设计原则（与 plan 对齐）：
 * - 强制 `import { test, expect } from '@playwright/test'`
 * - 强制 `test.describe` + `test.beforeEach` 分层
 * - 优先语义定位器；禁止使用 nth-child / 复杂 CSS / XPath
 * - 关键步骤追加中文注释
 */
/**
 * POM 导入路径说明：
 * - spec.ts 文件位于 <casesDir>/<group>/<sub>.spec.ts（group 子目录下）
 * - POM 文件位于 <casesDir>/pages/<sub>.page.ts（默认在 casesDir/pages/）
 * - 因此 spec.ts 中 import POM 应当写 "相对自身 spec.ts 所在目录" 的路径，例如:
 *     import { LoginPage } from '../pages/login-success.page.ts';
 * - 必须带 .ts 后缀（目标项目常为 ESM，模块解析强制要求完整扩展名）
 *
 * 多 POM 时也用同一形式拼接，例如:
 *     import { FooPage } from '../pages/foo.page.ts';
 *     import { BarPage } from '../pages/bar.page.ts';
 */
export const SPEC_TEMPLATE = `import { test, expect } from '@playwright/test';
{{POM_IMPORTS}}

/**
 * 用例名: {{NAME}}
 * 描述: {{DESCRIPTION}}
 * 创建时间: {{CREATED_AT}}
 * 标签: {{TAGS}}
 *
 * 设计原则:
 * - 仅使用语义定位器: getByRole / getByLabel / getByPlaceholder / getByTestId / getByText
 * - 每个独立场景拆分为独立的 test()
 * - 关键步骤追加中文注释说明意图
 */
test.describe('{{NAME_HUMAN}}', () => {
  test.beforeEach(async ({ page }) => {
    // TODO(agent): 在每个用例前准备共享前置条件(登录、清理状态等)
    // 示例: await page.goto('/');
  });

  test('{{DEFAULT_SCENARIO}}', async ({ page }) => {
    // 1. 准备 / 导航
    // await page.goto('/target-page');

    // 2. 执行交互
    // await page.getByRole('button', { name: '提交' }).click();

    // 3. 断言
    // await expect(page.getByText('成功')).toBeVisible();
  });
});
`;