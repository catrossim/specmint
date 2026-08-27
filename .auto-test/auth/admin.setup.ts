import { test as setup, expect } from '@playwright/test';

/**
 * admin 登录流程（手写模板）
 *
 * 流程结束后必须调用 `page.context().storageState({ path })` 保存登录态。
 * storageState 路径固定为：.auto-test/auth/storage/admin.json
 *
 * 推荐：登录成功后用 `await expect(page).toHaveURL(/dashboard/)` 等做断言，
 * 避免登录失败但 storageState 仍然生成（导致 e2e 用例莫名其妙失败）。
 */
const STORAGE_STATE = '.auto-test/auth/storage/admin.json';

setup('admin login', async ({ page }) => {
  await page.goto('/login');

  // TODO: 填入登录步骤
  // await page.getByLabel('用户名').fill('admin');
  // await page.getByLabel('密码').fill(process.env.ADMIN_PASSWORD ?? '');
  // await page.getByRole('button', { name: '登录' }).click();
  // await expect(page).toHaveURL(/dashboard/);

  await page.context().storageState({ path: STORAGE_STATE });
});
