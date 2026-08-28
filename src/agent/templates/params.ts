/**
 * interactiveElements 文本行 → 结构化元素解析 + 定位器生成辅助
 *
 * 输入格式（explore.ts INTERACTIVE_SNIPPET 产出）：
 *   - button#submit [role=button] [type=submit] [name=action] [data-testid=login-submit] "登录"
 *   - input#username [type=text] [name=username] "用户名"
 */
import type { InteractiveElement, FormField } from './types.js';

const ATTR_RE = /\[([a-z-]+)=([^\]]*)\]/g;

function parseLine(rest: string): InteractiveElement | null {
  let text = '';
  // 末尾 "文本"（最长 30 字符，由快照截断）
  const textMatch = rest.match(/ "([^"]*)"$/);
  if (textMatch) {
    text = textMatch[1] ?? '';
    rest = rest.slice(0, textMatch.index).trimEnd();
  }
  // 首个 token：tag#id
  const spaceIdx = rest.indexOf(' ');
  const head = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const attrsPart = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1);
  const hashIdx = head.indexOf('#');
  const tag = hashIdx === -1 ? head : head.slice(0, hashIdx);
  const id = hashIdx === -1 ? '' : head.slice(hashIdx + 1);
  if (!tag) return null;

  let role = '';
  let type = '';
  let name = '';
  let testid = '';
  let ariaLabel = '';
  for (const m of attrsPart.matchAll(ATTR_RE)) {
    const [, k = '', v = ''] = m;
    switch (k) {
      case 'role': role = v; break;
      case 'type': type = v; break;
      case 'name': name = v; break;
      case 'data-testid': testid = v; break;
      case 'aria-label': ariaLabel = v; break;
      // aria-labelledby 量少且需要二次查 DOM，跳过
    }
  }
  return { tag, id, role, type, name, testid, ariaLabel, text };
}

export function parseInteractiveElements(raw: string | null | undefined): InteractiveElement[] {
  if (!raw) return [];
  const out: InteractiveElement[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;
    const el = parseLine(trimmed.slice(2));
    if (el) out.push(el);
  }
  return out;
}

// --- 定位器生成（与 selectorPolicy 白名单一致：语义定位器优先）---

/** 单引号字符串转义（生成代码用） */
export function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** RegExp 字面量片段转义（含 `/`：生成的代码形如 /xxx/，斜杠不转义会变成行注释） */
export function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

const BUTTON_LIKE = new Set(['button', 'a', 'input']);

/**
 * 为交互元素生成 Playwright 定位器表达式（如 "page.getByTestId('login-submit')"）。
 * 优先级：data-testid > aria-label > name 属性 > id > role+text。
 * 生成不了（button 无任何标识）返回 null。
 */
export function locatorFor(el: InteractiveElement): string | null {
  if (el.testid) return `page.getByTestId('${esc(el.testid)}')`;
  if (el.ariaLabel) {
    if (el.tag === 'button' || el.role === 'button' || el.tag === 'a') {
      return `page.getByRole('button', { name: '${esc(el.ariaLabel)}' })`;
    }
    return `page.getByLabel('${esc(el.ariaLabel)}')`;
  }
  if (el.name) return `page.locator('[name="${esc(el.name)}"]')`;
  if (el.id) return `page.locator('#${esc(el.id)}')`;
  if ((el.tag === 'button' || el.role === 'button') && el.text) {
    return `page.getByRole('button', { name: '${esc(el.text)}' })`;
  }
  return null;
}

/** 元素的"可读名"：ariaLabel > testid > name > text > id */
export function readableLabel(el: InteractiveElement): string {
  return el.ariaLabel || el.text || el.name || el.testid || el.id || el.tag;
}

/** input/textarea/select 元素 */
export function isFormInput(el: InteractiveElement): boolean {
  return ['input', 'textarea', 'select'].includes(el.tag);
}

export function isButtonLike(el: InteractiveElement): boolean {
  return el.tag === 'button' || el.role === 'button' || (el.tag === 'input' && ['submit', 'button'].includes(el.type));
}

const HIDDEN_TYPES = new Set(['hidden', 'checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image']);

/** 按 input type 推导合法样例值 */
export function sampleValueFor(type: string): string {
  switch (type) {
    case 'email': return 'test@example.com';
    case 'tel': return '13800138000';
    case 'number': return '1';
    case 'date': return '2024-01-01';
    case 'url': return 'https://example.com';
    default: return '自动化测试';
  }
}

/** 把 input 元素转成 FormField 参数；无法生成定位器时返回 null */
export function toFormField(el: InteractiveElement): FormField | null {
  const locator = locatorFor(el);
  if (!locator) return null;
  return {
    label: readableLabel(el),
    locator,
    value: sampleValueFor(el.type),
  };
}

/** 过滤掉隐藏/特殊 type 的 input */
export function isTextLikeInput(el: InteractiveElement): boolean {
  return isFormInput(el) && !HIDDEN_TYPES.has(el.type) && el.type !== 'password';
}

// --- URL 处理 ---

/** 绝对 URL → 相对路径（spec 里 page.goto 配合 baseURL）；已经是相对路径则原样返回 */
export function toRelativePath(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const rel = u.pathname + u.search;
    return rel === '' ? '/' : rel;
  } catch {
    return url.startsWith('/') ? url : `/${url}`;
  }
}
