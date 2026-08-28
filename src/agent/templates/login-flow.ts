/**
 * 模板：登录流程（login-flow）
 *
 * 结构假设（高度收敛，快照提取率高）：
 * - 一个用户名输入框（type=text，name/aria/文本含"用户名/账号/邮箱/手机/user/account/email/phone"）
 * - 一个密码输入框（type=password）
 * - 一个提交按钮（文本含"登录/login/sign in"，找不到则退化为第一个按钮）
 */
import type { TemplateDefinition } from './types.js';
import {
  esc,
  escRe,
  isFormInput,
  isButtonLike,
  locatorFor,
  toRelativePath,
} from './params.js';

const USERNAME_RE =
  /(用户名|账号|账户|邮箱|手机|邮箱|user|account|username|email|phone|mobile)/i;
const SUBMIT_RE = /(登录|登陆|login|log in|sign in|signin)/i;

function signalText(el: { name: string; testid: string; ariaLabel: string; text: string }): string {
  return [el.name, el.testid, el.ariaLabel, el.text].join(' ');
}

export const loginFlow: TemplateDefinition = {
  name: 'login-flow',
  keywords: [/登录|登陆|log\s?in|sign\s?in/i],
  // 注册/找回密码/登出页面结构相近但语义不同，明确排除走 LLM
  exclude: [/注册|signup|sign\s?up|找回|重置密码|忘记密码|登出|logout/i],
  requiredParams: ['url', 'usernameLocator', 'passwordLocator', 'submitLocator'],

  extract: (ctx, elements) => {
    const params: Record<string, string> = {};

    const rel = toRelativePath(ctx.explore?.url ?? ctx.url);
    if (rel) params.url = rel;

    const passwordEl = elements.find((el) => isFormInput(el) && el.type === 'password');
    if (passwordEl) {
      const loc = locatorFor(passwordEl);
      if (loc) params.passwordLocator = loc;
    }

    const textInputs = elements.filter((el) => isFormInput(el) && el.type !== 'password');
    const usernameEl =
      textInputs.find((el) => USERNAME_RE.test(signalText(el))) ?? textInputs[0];
    if (usernameEl && (USERNAME_RE.test(signalText(usernameEl)) || textInputs.length === 1)) {
      // 有明确信号，或页面只有一个文本框（登录页高度收敛场景）
      const loc = locatorFor(usernameEl);
      if (loc) params.usernameLocator = loc;
    }

    const buttons = elements.filter(isButtonLike);
    const submitEl = buttons.find((el) => SUBMIT_RE.test(signalText(el))) ?? buttons[0];
    if (submitEl) {
      const loc = locatorFor(submitEl);
      if (loc) params.submitLocator = loc;
    }

    return params;
  },

  render: (params) => {
    const url = params.url as string;
    const userLoc = params.usernameLocator as string;
    const passLoc = params.passwordLocator as string;
    const submitLoc = params.submitLocator as string;
    const urlRe = escRe(url);

    const code = `import { test, expect } from '@playwright/test';

test.describe('用户认证 · 登录流程', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('${esc(url)}');
  });

  test('合法凭据登录成功并跳转', async ({ page }) => {
    // 模板生成：定位器来自页面快照（data-testid > aria-label > name > id）
    await ${userLoc}.fill('admin');
    await ${passLoc}.fill('admin123');
    await ${submitLoc}.click();
    // 等待离开登录页（成功跳转）
    await expect(page).not.toHaveURL(/${urlRe}/);
  });

  test('错误密码提示且停留在登录页', async ({ page }) => {
    await ${userLoc}.fill('admin');
    await ${passLoc}.fill('wrong-password');
    await ${submitLoc}.click();
    // 错误提示通过 role=status / role=alert 暴露
    await expect(page.getByRole('status').or(page.getByRole('alert'))).toBeVisible();
    await expect(page).toHaveURL(/${urlRe}/);
  });
});
`;

    return {
      name: 'login-flow-smoke',
      code,
      module: '用户认证',
      group: 'auth',
      tags: ['template', 'auth', 'login'],
    };
  },
};
