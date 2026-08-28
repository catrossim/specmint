/**
 * 模板：表单提交（form-submit）
 *
 * 结构假设：
 * - 页面有 ≥1 个文本类输入框（text/email/tel/number/date/url/textarea，排除密码/隐藏/文件）
 * - 有一个提交按钮（文本含"提交/保存/确定/submit/save"，找不到则退化为最后一个按钮）
 * - 成功反馈走 role=status（toast），校验错误走 role=alert
 */
import type { TemplateDefinition, FormField } from './types.js';
import {
  esc,
  isButtonLike,
  isFormInput,
  isTextLikeInput,
  locatorFor,
  toFormField,
  toRelativePath,
} from './params.js';

const SUBMIT_RE = /(提交|保存|确定|确认|发布|submit|save|confirm)/i;

const MAX_FIELDS = 5;

export const formSubmit: TemplateDefinition = {
  name: 'form-submit',
  keywords: [/表单|提交|填写|新建|新增|创建|form|submit|create/i],
  exclude: [/登录|登陆|log\s?in|sign\s?in|注册|signup|搜索|检索|search|筛选/i],
  requiredParams: ['url', 'fields', 'submitLocator'],

  extract: (ctx, elements) => {
    const params: Record<string, string | FormField[]> = {};

    const rel = toRelativePath(ctx.explore?.url ?? ctx.url);
    if (rel) params.url = rel;

    const fields: FormField[] = [];
    for (const el of elements) {
      // 排除密码框（登录表单已被 login-flow 排除词挡掉；普通业务表单出现密码框属异常结构）
      if (isFormInput(el) && el.type === 'password') continue;
      if (isTextLikeInput(el)) {
        const f = toFormField(el);
        if (f) fields.push(f);
      }
    }
    if (fields.length > 0) params.fields = fields.slice(0, MAX_FIELDS);

    const buttons = elements.filter(isButtonLike);
    // 提交按钮通常是表单最后一个按钮；优先按文本匹配，否则取最后一个
    const submitEl =
      buttons.find((el) => SUBMIT_RE.test([el.text, el.ariaLabel, el.testid, el.name].join(' '))) ??
      buttons[buttons.length - 1];
    if (submitEl) {
      const loc = locatorFor(submitEl);
      if (loc) params.submitLocator = loc;
    }

    return params;
  },

  render: (params) => {
    const url = params.url as string;
    const fields = params.fields as FormField[];
    const submitLoc = params.submitLocator as string;
    // requiredParams 守门保证 fields ≥ 1（自动/显式路径都查过），TS 看不到，断言之
    const first = fields[0]!;
    const rest = fields.slice(1);

    const fillAll = fields
      .map((f) => `    await ${f.locator}.fill('${esc(f.value)}'); // ${f.label}`)
      .join('\n');
    const fillRest = rest
      .map((f) => `    await ${f.locator}.fill('${esc(f.value)}'); // ${f.label}`)
      .join('\n');

    const code = `import { test, expect } from '@playwright/test';

test.describe('表单 · 提交', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('${esc(url)}');
  });

  test('填写全部字段后成功提交', async ({ page }) => {
    // 模板生成：字段定位器来自页面快照，填充值按 input type 推导
${fillAll}
    await ${submitLoc}.click();
    // 成功反馈走 role=status（toast）
    await expect(page.getByRole('status')).toBeVisible();
  });

  test('必填字段留空时阻止提交并提示', async ({ page }) => {
    // 故意留空第一个字段：${first.label}
${rest.length > 0 ? `${fillRest}\n` : ''}    await ${submitLoc}.click();
    // 校验错误走 role=alert
    await expect(page.getByRole('alert')).toBeVisible();
  });
});
`;

    return {
      name: 'form-submit-smoke',
      code,
      module: '表单',
      group: 'forms',
      tags: ['template', 'form'],
    };
  },
};
