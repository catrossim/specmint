/**
 * Page Object 模板
 *
 * 仅在 generate --page-object 时使用。
 * 用例脚本中的所有元素定位应该引用本类，避免在 spec 中散落。
 */
export const PAGE_OBJECT_TEMPLATE = `import type { Page, Locator } from '@playwright/test';

/**
 * 页面对象: {{NAME_CLASS}}Page
 * 目标 URL: {{URL}}
 *
 * 封装 {{URL}} 上所有可复用元素与操作，提升用例可读性与可维护性。
 */
export class {{NAME_CLASS}}Page {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // TODO(agent): 根据实际页面补充定位器,优先语义定位器
  // readonly submitButton: Locator = this.page.getByRole('button', { name: '提交' });
  // readonly usernameInput: Locator = this.page.getByLabel('用户名');

  /**
   * 导航到目标 URL
   */
  async goto(): Promise<void> {
    await this.page.goto('{{URL}}');
  }
}
`;