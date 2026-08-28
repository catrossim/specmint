/**
 * 浏览器通道解析：解决内网/受限环境无法下载 Playwright 自带 chromium 的痛点。
 *
 * 设计要点：
 * - `auto` 模式检测链 = Playwright chromium → 系统 Chrome → 系统 Edge
 * - 用 `existsSync(chromium.executablePath())` 而非 launch 探测，避免启动开销
 * - 回退时打印一次性提示，不打扰静默场景
 * - 全缺失时返回 null，由调用方给三选一指引（install / 内网镜像 / 系统浏览器）
 *
 * 注意：`chromiumApi.channel('chrome').executablePath()` 是 Playwright 公开 API，
 * 在 channel 不存在时也可能返回预期路径但实际缺失；统一用 existsSync 二次确认。
 */
import { existsSync } from 'node:fs';
import { chromium as chromiumApi } from '@playwright/test';
import { logger } from '../utils/logger.js';

/** `BrowserType.channel()` 是 Playwright 内部 API，公开类型未导出，这里窄化为 duck type。 */
const chromiumAny = chromiumApi as unknown as {
  executablePath(): string;
  channel(name: 'chrome' | 'msedge'): { executablePath(): string };
};

export type BrowserChannel = 'chromium' | 'chrome' | 'msedge';
export type BrowserChannelPreference = BrowserChannel | 'auto';

export interface ResolvedBrowserChannel {
  /** undefined = 用 Playwright 自带 chromium（不设 channel 字段） */
  channel?: BrowserChannel;
  /** 是否发生了 auto → chrome/msedge 的回退 */
  fellBack: boolean;
  /** 三者皆不可用时给上层打印的指引 */
  unavailable?: string;
}

export const NO_BROWSER_GUIDANCE = [
  '未找到可用浏览器，请按场景选择其一：',
  '  1. 联网环境         npx playwright install chromium',
  '  2. 内网/受限环境    PLAYWRIGHT_DOWNLOAD_HOST=<内网镜像> npx playwright install chromium',
  '  3. 已装 Chrome/Edge  自动回退；若仍未生效，确认浏览器确实安装（macOS /Applications、Linux which、Win 注册表）',
  '或显式指定 channel：runner.browserChannel: "chrome" / "msedge"（.auto-test/config.json）',
].join('\n');

export function resolveBrowserChannel(
  preference: BrowserChannelPreference,
): ResolvedBrowserChannel {
  if (preference === 'chromium') return { fellBack: false };
  if (preference === 'chrome' || preference === 'msedge') {
    return { channel: preference, fellBack: false };
  }
  // auto：检测链 chromium → chrome → msedge
  try {
    if (existsSync(chromiumAny.executablePath())) {
      return { fellBack: false };
    }
  } catch {
    // executablePath() 极端情况抛错，继续后续检测
  }
  try {
    if (existsSync(chromiumAny.channel('chrome').executablePath())) {
      logger.warn(
        '[auto-test] Playwright chromium 未检测到，自动回退使用系统 Chrome（channel=chrome）',
      );
      return { channel: 'chrome', fellBack: true };
    }
  } catch {
    /* fall through */
  }
  try {
    if (existsSync(chromiumAny.channel('msedge').executablePath())) {
      logger.warn(
        '[auto-test] Playwright chromium 与系统 Chrome 均不可用，自动回退使用系统 Edge（channel=msedge）',
      );
      return { channel: 'msedge', fellBack: true };
    }
  } catch {
    /* fall through */
  }
  return { fellBack: false, unavailable: NO_BROWSER_GUIDANCE };
}