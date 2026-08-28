/**
 * 模板：详情页冒烟（detail-page）
 *
 * 定位是"页面可访问性冒烟"而非精确字段断言（字段值不在交互元素快照里）：
 * - 断言页面 title 包含期望片段（来源：--set titlePattern > description 提取 > explore.title）
 * - 断言页面至少有一个可见操作元素（活性检查）
 */
import type { TemplateDefinition } from './types.js';
import { esc, escRe, toRelativePath } from './params.js';

/** 从描述提取标题候选：如"订单详情页" → "订单详情" */
function titleFromDescription(description: string): string | undefined {
  const m = description.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,12}(?:详情|明细|detail))/i);
  if (m) return m[1];
  return undefined;
}

export const detailPage: TemplateDefinition = {
  name: 'detail-page',
  keywords: [/详情|明细|detail/i],
  exclude: [/编辑|修改|更新|edit|update|新建|创建|create/i],
  requiredParams: ['url', 'titlePattern'],

  extract: (ctx, elements) => {
    const params: Record<string, string> = {};

    const rel = toRelativePath(ctx.explore?.url ?? ctx.url);
    if (rel) params.url = rel;

    void elements; // 详情页模板不依赖交互元素（标题与字段值均不在其中）
    // explore.title 是实际页面标题（断言必过，最可靠）；描述提取仅作无快照时的兜底
    const title = ctx.explore?.title ?? titleFromDescription(ctx.description);
    if (title) params.titlePattern = title;

    return params;
  },

  render: (params) => {
    const url = params.url as string;
    const titlePattern = params.titlePattern as string;

    const code = `import { test, expect } from '@playwright/test';

test.describe('详情 · 展示', () => {
  test('详情页可访问且标题正确', async ({ page }) => {
    // 模板生成：冒烟级断言（title + 页面活性），字段级断言请补充或走 LLM 生成
    await page.goto('${esc(url)}');
    await expect(page).toHaveTitle(/${escRe(titlePattern)}/);
    // 活性检查：页面至少有一个可见操作元素
    await expect(page.locator('button, a').first()).toBeVisible();
  });
});
`;

    return {
      name: 'detail-page-smoke',
      code,
      module: '详情',
      group: 'pages',
      tags: ['template', 'smoke'],
    };
  },
};
