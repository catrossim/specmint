/**
 * spec.ts 头部元数据解析（`@specmint` 注释块）
 *
 * 用途：让宿主 agent（skill）或人工在写用例时，把元数据就近写在文件里，
 * `specmint adopt` 时自动读取，不必每次都在命令行敲一堆参数。
 *
 * 支持的写法（块注释与行注释均可，可混用）：
 *
 * ```ts
 * /**
 *  * @specmint module: 用户认证
 *  * @specmint group: auth
 *  * @specmint priority: P0
 *  * @specmint ticket: AUTH-101, AUTH-102
 *  * @specmint tag: smoke, happy-path
 *  * @specmint auth: admin
 *  * @specmint description: 管理员登录成功跳转 dashboard
 *  *\/
 * ```
 * ```ts
 * // @specmint module: 用户认证
 * ```
 *
 * 优先级由调用方决定（约定：CLI 显式 > 本文件注释 > 路径推导）。
 */

export interface ParsedSpecMeta {
  /** 模块中文名 */
  module?: string;
  /** 功能分组（kebab-case） */
  group?: string;
  /** 优先级原文（P0|P1|P2|P3 或同义词，由归一化层校验） */
  priority?: string;
  /** auth 角色名 */
  auth?: string;
  /** 标签列表 */
  tags: string[];
  /** 关联单号列表 */
  linkedTickets: string[];
  /** 用例描述 */
  description?: string;
}

/** 可识别的字段名 → 归一化后的字段 */
const FIELD_ALIASES: Record<string, keyof ParsedSpecMeta> = {
  module: 'module',
  mod: 'module',
  group: 'group',
  priority: 'priority',
  pri: 'priority',
  auth: 'auth',
  role: 'auth',
  tag: 'tags',
  tags: 'tags',
  ticket: 'linkedTickets',
  tickets: 'linkedTickets',
  description: 'description',
  desc: 'description',
};

/** 逗号 / 顿号 / 空格分隔的字符串 → 列表 */
function splitList(raw: string): string[] {
  return raw
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 解析 spec.ts 源码中的 `@specmint` 注释块。
 *
 * 只做「提取」，不做归一化与校验（交给 `normalizeCaseMeta`），
 * 保证解析层与校验层的职责不交叉。
 */
export function parseSpecMeta(code: string): ParsedSpecMeta {
  const result: ParsedSpecMeta = { tags: [], linkedTickets: [] };

  // 逐行扫描：同时覆盖 `// @specmint k: v`、`* @specmint k: v`、`/* @specmint k: v */`
  const lines = code.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    // 剥掉行首的注释标记与星号
    const cleaned = line.replace(/^(\/\/|\/\*+|\*+|\*+\/)?\s*/, '');
    const m = /^@specmint\s+([A-Za-z]+)\s*[:：]\s*(.*)$/.exec(cleaned);
    if (!m) continue;

    const rawKey = m[1]!.toLowerCase();
    const rawValue = (m[2] ?? '').trim();
    const field = FIELD_ALIASES[rawKey];
    if (!field || rawValue === '') continue;

    switch (field) {
      case 'tags':
        result.tags.push(...splitList(rawValue));
        break;
      case 'linkedTickets':
        result.linkedTickets.push(...splitList(rawValue));
        break;
      case 'module':
      case 'group':
      case 'priority':
      case 'auth':
      case 'description':
        // 单值字段：首次出现生效，后续重复以首次为准（避免不确定行为）
        if (result[field] === undefined) {
          result[field] = rawValue;
        }
        break;
    }
  }

  result.tags = dedupe(result.tags);
  result.linkedTickets = dedupe(result.linkedTickets);
  return result;
}

/**
 * 从 spec.ts 源码推断用例描述（供 `description` 缺失时兜底）。
 *
 * 顺序：
 * 1. `test.describe('标题'` —— 最能代表整个文件
 * 2. 第一个 `test('标题'` —— 单用例文件
 * 3. null（调用方再决定是报错还是用文件名）
 *
 * 只取字符串字面量，模板字符串（`test(\`...\`)`）不支持（动态标题没有静态语义）。
 */
export function extractCaseTitle(code: string): string | null {
  const describeMatch = /test\.describe\s*\(\s*['"`]([^'"`]+)['"`]/.exec(code);
  if (describeMatch) return describeMatch[1]!.trim();

  const testMatch = /\btest\s*\(\s*['"`]([^'"`]+)['"`]/.exec(code);
  if (testMatch) return testMatch[1]!.trim();

  return null;
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
