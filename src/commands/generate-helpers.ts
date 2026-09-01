/**
 * generate 命令相关的纯函数助手（不依赖外部 IO，便于测试）。
 *
 * 当前内容：
 * - `looksLikeLoginPage` 启发式判断探索结果是否登录页，用于未注入 auth 时的 warning 触发。
 *
 * 后续如有更多纯逻辑助手也归到这里；保持 generate.ts 主体只关心流水线编排。
 */

/**
 * 启发式探测：探索结果是否看起来是登录页？
 * 规则（命中任一即视为登录页）：
 *   1. title 或 URL 含 login / signin / sign-in / sso / oauth / 登录 关键字
 *   2. accessibilitySnapshot 或 interactiveElements 文本含 `type=password` 或 `password` 关键字
 *
 * 注意：仅做粗粒度匹配，命中率高但误报也不致命——只是 warning，不会 fail-fast。
 *
 * @param title  页面 <title>（可能为空字符串）
 * @param finalUrl  探索结束后的最终 URL
 * @param snapshot 可选：Playwright accessibilitySnapshot 字符串
 * @param interactive 可选：Playwright interactiveElements 字符串
 */
export function looksLikeLoginPage(
  title: string,
  finalUrl: string,
  snapshot?: string,
  interactive?: string,
): boolean {
  // 注意：\b 在 JS 正则里只匹配 ASCII 词边界，对中日韩不友好，所以中文"登录"两边不要 \b。
  // 用一个 lookahead/lookbehind-free 的写法：直接 contains。
  const haystack = `${title}\n${finalUrl}`;
  const titleOrUrlHit =
    /(login|signin|sign-in|sso|oauth)/i.test(haystack) || haystack.includes('登录');
  if (titleOrUrlHit) return true;
  const snapshotHit = snapshot && /(type=password|\bpassword\b)/i.test(snapshot);
  const interactiveHit = interactive && /(type=password|\bpassword\b)/i.test(interactive);
  return Boolean(snapshotHit || interactiveHit);
}