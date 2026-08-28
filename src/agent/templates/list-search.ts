/**
 * 模板：列表搜索（list-search）
 *
 * 结构假设：
 * - 有一个搜索输入框（type=search 优先；否则 name/testid/aria 含"搜索/关键字/关键词/search/query/filter"）
 * - 搜索词 keyword 无法从快照提取（列表内容不在交互元素里），
 *   从 description 的引号片段或"编号类"token（如 ORD-2024）提取，提取不到 → miss 回退 LLM
 */
import type { TemplateDefinition } from './types.js';
import { esc, isFormInput, locatorFor, toRelativePath } from './params.js';

const SEARCH_RE = /(搜索|检索|关键字|关键词|筛选|search|query|filter|keyword)/i;

/** 从描述提取搜索词候选：引号片段 > 编号类 token（ORD-2024 / #123 / A-1） */
function keywordFromDescription(description: string): string | undefined {
  const quoted = description.match(/["'“”‘’]([^"'“”‘’]{2,30})["'“”‘’]/);
  if (quoted) return quoted[1];
  const codeLike = description.match(/\b([A-Za-z]{2,}-?\d[\w-]*)\b/);
  if (codeLike) return codeLike[1];
  return undefined;
}

export const listSearch: TemplateDefinition = {
  name: 'list-search',
  keywords: [/列表|搜索|检索|筛选|list|search|filter/i],
  exclude: [/登录|登陆|注册|表单|提交|form|submit|详情|detail/i],
  requiredParams: ['url', 'searchLocator', 'keyword'],

  extract: (ctx, elements) => {
    const params: Record<string, string> = {};

    const rel = toRelativePath(ctx.explore?.url ?? ctx.url);
    if (rel) params.url = rel;

    const inputs = elements.filter(isFormInput);
    const searchEl =
      inputs.find((el) => el.type === 'search') ??
      inputs.find((el) => SEARCH_RE.test([el.name, el.testid, el.ariaLabel, el.id].join(' ')));
    if (searchEl) {
      const loc = locatorFor(searchEl);
      if (loc) params.searchLocator = loc;
    }

    const kw = ctx.overrides.keyword ?? keywordFromDescription(ctx.description);
    if (kw) params.keyword = kw;

    return params;
  },

  render: (params) => {
    const url = params.url as string;
    const searchLoc = params.searchLocator as string;
    const keyword = params.keyword as string;
    const rowLoc = (params.rowLocator as string | undefined) ?? `page.getByTestId('row')`;

    const code = `import { test, expect } from '@playwright/test';

test.describe('列表 · 搜索筛选', () => {
  test('输入关键词后列表仅展示命中项', async ({ page }) => {
    await page.goto('${esc(url)}');
    // 模板生成：行定位器默认 data-testid="row"，如与实际不符请通过 --set rowLocator=... 覆盖
    const rows = ${rowLoc};
    // 等待首屏加载完成
    await expect(rows.first()).toBeVisible();
    await ${searchLoc}.fill('${esc(keyword)}');
    await page.keyboard.press('Enter');
    // 断言仍有结果行
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    // 抽查首行包含关键词（大小写不敏感）
    await expect(rows.first()).toContainText('${esc(keyword)}', { ignoreCase: true });
  });
});
`;

    return {
      name: 'list-search-smoke',
      code,
      module: '列表',
      group: 'lists',
      tags: ['template', 'list', 'search'],
    };
  },
};
