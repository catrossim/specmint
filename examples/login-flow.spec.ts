/**
 * 用例名: login-flow
 * 描述: specmint examples 的登录流程端到端用例（手写范例）
 *
 * 该文件位于 examples/ 下，不会被 Playwright 自动发现（testDir=./tests）。
 * 验证步骤：复制到 tests/login-flow.spec.ts 后执行 `specmint run`。
 *
 * 设计原则演示：
 * - 仅使用语义定位器：getByLabel / getByTestId / getByRole / getByText
 * - 每个独立场景拆分为独立 test()
 * - 关键步骤追加中文注释说明意图
 * - 不使用 nth-child / 复杂 CSS / XPath
 */
import { test, expect } from '@playwright/test';

test.describe('specmint examples · 登录流程', () => {
  test.beforeEach(async ({ page }) => {
    // 进入示例应用首页（baseURL 由 playwright.config.ts 提供）
    await page.goto('/login-demo.html');
    // 等待表单可见
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
  });

  test('合法凭据登录成功并跳转到 dashboard', async ({ page }) => {
    // 1. 用 getByLabel 填写用户名（label > input 关联，无需 data-testid）
    await page.getByLabel('用户名').fill('admin');
    // 2. 用 getByLabel 填写密码
    await page.getByLabel('密码').fill('admin123');
    // 3. 用 getByTestId 点击登录
    await page.getByTestId('login-submit').click();
    // 4. 等待跳转并断言 dashboard 标题
    await expect(page).toHaveURL(/dashboard\.html$/);
    await expect(page.getByTestId('dashboard-title')).toHaveText('Dashboard');
  });

  test('错误密码显示用户名或密码错误', async ({ page }) => {
    await page.getByLabel('用户名').fill('admin');
    await page.getByLabel('密码').fill('wrong-password');
    await page.getByTestId('login-submit').click();

    // 错误提示通过 role=status + aria-live="polite" 暴露
    await expect(page.getByRole('status')).toHaveText('用户名或密码错误');
    // 仍在登录页
    await expect(page).toHaveURL(/login-demo\.html$/);
  });

  test('空表单提交停留在登录页', async ({ page }) => {
    // 不填任何字段，直接点击登录
    await page.getByTestId('login-submit').click();
    await expect(page).toHaveURL(/login-demo\.html$/);
  });
});