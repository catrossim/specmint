/**
 * 页面探索器（仅在 generate --url 时启用）
 *
 * 职责：
 * - 启动浏览器、打开目标 URL、提取 a11y 树 + 交互元素清单
 * - 字符串化后作为 prompt 上下文喂给 pi-agent，提升定位准确度
 * - try/finally 保证浏览器进程关闭，不残留
 *
 * 设计取舍：
 * - 浏览器通道走 resolveBrowserChannel()：auto 检测链 chromium → chrome → msedge，
 *   让内网/受限环境用户开箱即用（无需下载 Playwright chromium）
 * - 启动失败时给三选一指引（install chromium / 内网镜像 / 装系统 Chrome|Edge）
 * - a11y 树通过 `page.evaluate` 用字符串形式提交（绕过 tsx/esbuild 在
 *   嵌套函数上注入 __name 辅助函数导致的 ReferenceError）
 * - Playwright 1.62+ 已移除 `page.accessibility.snapshot()`，自己实现简化版
 */
import { chromium, type Page, type Browser } from 'playwright';
import { CliError, ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { resolveBrowserChannel, NO_BROWSER_GUIDANCE } from '../runner/browser-channel.js';
import {
  readExploreCache,
  writeExploreCache,
  type ExploreCacheKeyParams,
} from './explore-cache.js';

export interface ExploreOptions {
  url: string;
  headless?: boolean;
  timeoutMs?: number;
  maxElements?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  /**
   * 探索快照缓存。
   * - `enabled === false` 完全跳过读/写（CLI `--no-explore-cache` 走这条路）
   * - 未传则默认启用
   * - `storageStateFingerprint` 用于多角色场景，避免不同登录态共用同一份快照
   */
  cache?: {
    enabled?: boolean;
    dir?: string;
    ttlMs?: number;
    storageStateFingerprint?: string;
  };
}

export interface ExploreResult {
  url: string;
  title: string;
  accessibilitySnapshot: string;
  interactiveElements: string;
  durationMs: number;
  /**
   * 当前结果是否命中缓存。命中时 durationMs = 0（未实际启动浏览器）。
   * 字段为可选是为了向后兼容已有调用方；默认 false。
   */
  fromCache?: boolean;
}

export async function explorePage(options: ExploreOptions): Promise<ExploreResult> {
  const headless = options.headless ?? true;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxElements = options.maxElements ?? 200;
  const waitUntil = options.waitUntil ?? 'domcontentloaded';
  const cacheEnabled = options.cache?.enabled !== false;

  const cacheKeyParams: ExploreCacheKeyParams = {
    url: options.url,
    headless,
    timeoutMs,
    maxElements,
    waitUntil,
    storageStateFingerprint: options.cache?.storageStateFingerprint,
  };

  // 1. 先查缓存。命中直接返回，跳过浏览器启动。
  if (cacheEnabled) {
    const dir = options.cache?.dir ?? '.auto-test/cache/explore';
    const hit = readExploreCache(cacheKeyParams, { dir });
    if (hit) {
      logger.info(`[explore] 缓存命中，跳过浏览器: ${hit.title} (${hit.url})`);
      return hit;
    }
  }

  const start = Date.now();

  // 浏览器通道决策：auto → chromium / chrome / msedge 三者择一可用
  const { channel, unavailable } = resolveBrowserChannel('auto');
  let browser: Browser | null = null;
  browser = await chromium.launch({ headless, ...(channel ? { channel } : {}) }).catch((err) => {
    throw new CliError({
      code: ExitCode.AGENT_ERROR,
      message: `启动浏览器失败：${(err as Error).message}`,
      hint: unavailable ?? NO_BROWSER_GUIDANCE,
    });
  });

  try {
    const context = await browser.newContext();
    const page: Page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    await page.goto(options.url, { waitUntil });
    const finalUrl = page.url();
    const title = await page.title();

    const accessibilitySnapshot = await extractAccessibilityTree(page, maxElements);
    const interactiveElements = await collectInteractiveElements(page, maxElements);

    const result: ExploreResult = {
      url: finalUrl,
      title,
      accessibilitySnapshot,
      interactiveElements,
      durationMs: Date.now() - start,
      fromCache: false,
    };

    // 2. 探索成功才落缓存。失败/异常不会污染缓存。
    if (cacheEnabled) {
      const dir = options.cache?.dir ?? '.auto-test/cache/explore';
      const ttlMs = options.cache?.ttlMs ?? 600_000;
      writeExploreCache(cacheKeyParams, result, { dir, ttlMs });
    }

    return result;
  } catch (err) {
    throw new CliError({
      code: ExitCode.AGENT_ERROR,
      message: `页面探索失败：${(err as Error).message}`,
      hint: '请检查 URL 是否可访问，或加长 timeoutMs',
    });
  } finally {
    try {
      await browser.close();
    } catch (err) {
      logger.warn(`关闭浏览器失败：${(err as Error).message}`);
    }
  }
}

// --- a11y tree（字符串形式 evaluate，绕过 esbuild __name 注入）---

const A11Y_TREE_SNIPPET = `(max) => {
  const IMPLICIT = {
    BUTTON: 'button', A: 'link', INPUT: 'textbox', SELECT: 'combobox',
    TEXTAREA: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading',
    H4: 'heading', H5: 'heading', H6: 'heading', IMG: 'img',
    NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo',
    ASIDE: 'complementary', FORM: 'form', UL: 'list', OL: 'list',
    LI: 'listitem', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader',
    SECTION: 'region', ARTICLE: 'article', DIALOG: 'dialog',
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META']);
  const lines = [];
  let count = 0;
  let truncated = false;
  function walk(el, depth) {
    if (count >= max) { truncated = true; return; }
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag)) return;
    const role = el.getAttribute('role') || IMPLICIT[tag] || '';
    let name = el.getAttribute('aria-label') || '';
    const labelledBy = el.getAttribute('aria-labelledby');
    if (!name && labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref) name = (ref.textContent || '').trim();
    }
    if (!name) name = el.getAttribute('title') || '';
    if (!name && (tag === 'INPUT' || tag === 'TEXTAREA')) {
      name = el.placeholder || '';
    }
    if (role || name) {
      lines.push('  '.repeat(depth) + '- ' + role + (name ? ' "' + String(name).slice(0, 60) + '"' : ''));
      count++;
    }
    for (const child of Array.from(el.children)) walk(child, depth + 1);
  }
  walk(document.body, 0);
  if (truncated) lines.push('... (截断，已达 ' + max + ' 上限)');
  return lines.join('\\n') || '(空)';
}`;

async function extractAccessibilityTree(
  page: Page,
  maxElements: number,
): Promise<string> {
  return page.evaluate(A11Y_TREE_SNIPPET, maxElements);
}

// --- interactive elements ---

const INTERACTIVE_SNIPPET = `(max) => {
  function tagDesc(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const role = el.getAttribute('role');
    const type = el instanceof HTMLInputElement ? el.type : '';
    const name = (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) ? el.name : '';
    const testid = el.getAttribute('data-testid');
    const ariaLabel = el.getAttribute('aria-label');
    const labelledBy = el.getAttribute('aria-labelledby');
    const text = (el.textContent || '').trim().slice(0, 30);
    const parts = [tag + id];
    if (role) parts.push('[role=' + role + ']');
    if (type) parts.push('[type=' + type + ']');
    if (name) parts.push('[name=' + name + ']');
    if (testid) parts.push('[data-testid=' + testid + ']');
    if (ariaLabel) parts.push('[aria-label=' + ariaLabel + ']');
    if (labelledBy) parts.push('[aria-labelledby=' + labelledBy + ']');
    if (text) parts.push('"' + text + '"');
    return parts.join(' ');
  }
  const selectors = 'button,input,select,textarea,a[href],[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="combobox"],[data-testid]';
  const candidates = document.querySelectorAll(selectors);
  const seen = new Set();
  const lines = [];
  for (const el of Array.from(candidates).slice(0, max)) {
    const desc = tagDesc(el);
    if (seen.has(desc)) continue;
    seen.add(desc);
    lines.push('- ' + desc);
  }
  return lines.join('\\n');
}`;

async function collectInteractiveElements(
  page: Page,
  maxElements: number,
): Promise<string> {
  return page.evaluate(INTERACTIVE_SNIPPET, maxElements);
}