import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright 运行配置
 * - 由 `auto-test run` 子命令通过 @playwright/test Node API 触发
 * - 也可手动 `npx playwright test` 直接使用
 *
 * 自定义 reporter `./dist/runner/reporter.js` 会把每次运行结果
 * 落盘到 `reports/runs/<timestamp>/run.json`，供 `auto-test history`/`auto-test rerun` 使用。
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list'],
    ['./dist/runner/reporter.js'],
  ],
  use: {
    baseURL: process.env.AUTO_TEST_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});