/**
 * spec.ts 静态校验规则引擎
 *
 * 定位：把原先「写在 prompt 里求 LLM 遵守」的软约束，变成「可执行、可进 CI」的硬检查。
 *
 * 背景：
 * - generate 路径下，风格约束只是 prompt 文本（`src/agent/prompts.ts` 的 STYLE_RULES），
 *   LLM 不遵守也照样落盘，没有任何机制拦得住。
 * - adopt 路径下，用例由宿主 agent / 人工编写，specmint 更没有机会"引导"，只能事后校验。
 * 因此这里提供统一的规则实现，供 `specmint lint` 与 `specmint adopt` 共用（规则只有一份）。
 *
 * 严格度语义（由调用方决定如何使用，本模块只标记 severity）：
 * - error：质量红线，adopt 默认拒绝纳管
 * - warn ：软性问题，adopt 打印提示但允许纳管
 *
 * 实现取舍：
 * - 不做 AST 解析（不引第三方 parser，避免给 CLI 绑依赖）：用「剥注释 + 剥字符串字面量」
 *   两档掩码 + 正则。规则命中率优先，宁可少报也不错报。
 * - 掩码保持行数与换行位置不变，因此可按原始源码精确回填行号。
 */
import { loadContract } from '../contract.js';
import { logger } from './logger.js';
import type { LintRulesOverrides } from './lint-plugin.js';

export type LintSeverity = 'error' | 'warn';

export interface LintIssue {
  /** 规则 id，与 LINT_RULES 对齐 */
  rule: string;
  severity: LintSeverity;
  message: string;
  /** 1-based 行号（基于原始源码） */
  line?: number;
  /** 命中行的裁剪片段，便于终端直接定位 */
  snippet?: string;
}

export interface LintResult {
  /** 无 error 时为 true；warn 不影响 */
  ok: boolean;
  /** 相对 cwd 的路径（正斜杠），人类可读与 JSON 输出共用 */
  file: string;
  errors: LintIssue[];
  warnings: LintIssue[];
}

export interface LintOptions {
  /**
   * 契约中声明的 testId 集合。
   * - 传入 Set：启用 unknown-testid 规则（未在契约内声明的 testid → warn）
   * - null / 省略：跳过该规则（无契约时不做无谓告警）
   */
  contractTestIds?: ReadonlySet<string> | null;
  /**
   * v0.7.0 新增：用户配置覆盖（来自 `.specmint/lint-rules.json`）。
   * - 'error' / 'warn'：覆盖规则默认 severity
   * - 'off'：完全禁用该规则（issue 不出现在结果中）
   * - 未列出的规则：保持 LINT_RULES 中的默认 severity
   */
  overrides?: LintRulesOverrides;
}

/** 规则清单（供文档生成与 `--help` 展示复用） */
export const LINT_RULES: ReadonlyArray<{
  id: string;
  severity: LintSeverity;
  description: string;
}> = [
  {
    id: 'missing-playwright-import',
    severity: 'error',
    description: "必须 `import { test, expect } from '@playwright/test'`",
  },
  {
    id: 'no-test-block',
    severity: 'error',
    description: '必须至少有一个 test(...) 用例块',
  },
  {
    id: 'no-assertion',
    severity: 'error',
    description: '必须至少有一个具体断言（expect(...).toBeXxx/toHaveXxx 等）',
  },
  {
    id: 'wait-for-timeout',
    severity: 'error',
    description: '禁止 page.waitForTimeout() 固定等待',
  },
  {
    id: 'brittle-selector',
    severity: 'error',
    description: '禁止易碎定位器：nth-child / nth-of-type / xpath / 复杂 CSS',
  },
  {
    id: 'debug-leftover',
    severity: 'warn',
    description: '禁止遗留调试代码：console.* / debugger',
  },
  {
    id: 'unknown-testid',
    severity: 'warn',
    description: 'data-testid 未在契约 contract.json 中声明',
  },
];

// v0.7.0 新增：从 LINT_RULES 派生的已知规则 id 集合，供 overrides 校验用
export const KNOWN_RULE_IDS: ReadonlyArray<string> = LINT_RULES.map((r) => r.id);

// --- 掩码：剥注释 / 剥字符串 ---

/**
 * 剥注释（保留字符串字面量内容）。
 * 用于「需要读取字符串内容」的规则：选择器黑名单、testid 契约校验。
 */
function stripComments(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i]!;
    const next = i + 1 < n ? code[i + 1] : undefined;

    if (c === '/' && next === '/') {
      while (i < n && code[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        out += code[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    // 进入字符串字面量：原样拷贝（含转义），避免把引号内的 // 或 /* 当注释
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n && code[i] !== quote) {
        if (code[i] === '\\' && i + 1 < n) {
          out += code[i]! + code[i + 1]!;
          i += 2;
          continue;
        }
        out += code[i]!;
        i++;
      }
      if (i < n) {
        out += quote;
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 在「已剥注释」的基础上把字符串字面量内容替换为等长空格（引号保留为空格）。
 * 用于「关键字检测」类规则，避免注释 / 字符串里的同名文本造成误报。
 *
 * 换行符一律保留，保证与原始源码行号对齐。
 */
function maskStrings(code: string): string {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += ' ';
      i++;
      while (i < n && code[i] !== quote) {
        if (code[i] === '\\' && i + 1 < n) {
          out += '  ';
          i += 2;
          continue;
        }
        out += code[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += ' ';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// --- 定位工具 ---

function lineOf(code: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) {
    if (code[i] === '\n') line++;
  }
  return line;
}

function snippetAt(code: string, index: number): string {
  const start = code.lastIndexOf('\n', index) + 1;
  let end = code.indexOf('\n', index);
  if (end === -1) end = code.length;
  return code.slice(start, end).trim().slice(0, 120);
}

/**
 * 在 masked 代码（与源码行号对齐）上按正则收集命中项。
 * 每次命中都回填原始源码的行号与片段。
 */
function collect(
  masked: string,
  source: string,
  re: RegExp,
  build: (match: RegExpExecArray, line: number, snippet: string) => LintIssue,
): LintIssue[] {
  const out: LintIssue[] = [];
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = rx.exec(masked)) !== null) {
    if (m[0].length === 0) {
      rx.lastIndex++;
      continue;
    }
    out.push(build(m, lineOf(masked, m.index), snippetAt(source, m.index)));
  }
  return out;
}

// --- 规则实现 ---

/** 从 masked 代码中提取 `page.locator('<sel>')` 一类的选择器字面量 */
function extractSelectors(withoutComments: string): Array<{ selector: string; index: number }> {
  const out: Array<{ selector: string; index: number }> = [];
  // 覆盖 locator / $ / $$ 三种入口；getByXxx 系列不在检测范围（本身就是语义定位器）
  const rx = /\.locator\s*\(\s*(['"`])([\s\S]*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(withoutComments)) !== null) {
    out.push({ selector: m[2] ?? '', index: m.index });
  }
  return out;
}

/** 判断 CSS 选择器是否「复杂 / 易碎」 */
function isBrittleSelector(selector: string): boolean {
  const s = selector.trim();
  if (!s) return false;
  if (/^xpath\s*=/i.test(s) || /^\/\//.test(s)) return true; // xpath= 或 // 开头
  if (/:nth-(child|of-type)\s*\(/i.test(s)) return true;
  if (s.includes('>') || s.includes('+') || s.includes('~')) return true; // 组合器
  if (s.includes('[')) return true; // 属性选择器
  if (/\s/.test(s)) return true; // 后代选择器（多段）
  return false;
}

/**
 * 校验一段 spec.ts 源码。
 *
 * @param code spec.ts 源码
 * @param options 可选：契约 testId 集合（启用 unknown-testid 规则）
 */
export function lintSpecCode(
  code: string,
  options: LintOptions = {},
): { errors: LintIssue[]; warnings: LintIssue[] } {
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];

  const withoutComments = stripComments(code);
  const masked = maskStrings(withoutComments);

  // 1. missing-playwright-import
  if (!/from\s+['"]@playwright\/test['"]/.test(withoutComments)) {
    errors.push({
      rule: 'missing-playwright-import',
      severity: 'error',
      message: "缺少 `import { test, expect } from '@playwright/test'`",
    });
  }

  // 2. no-test-block：test(...) 或 test.describe(...)
  if (!/\btest\s*\(/.test(masked) && !/\btest\.describe\s*\(/.test(masked)) {
    errors.push({
      rule: 'no-test-block',
      severity: 'error',
      message: '未找到任何 test(...) 用例块，该文件不会产生可执行用例',
    });
  }

  // 3. no-assertion：expect(...) 后必须跟具体 matcher（.toBeXxx / .toHaveXxx / .toContainText 等）
  if (!/\.to[A-Z]\w*\s*\(/.test(masked)) {
    errors.push({
      rule: 'no-assertion',
      severity: 'error',
      message: '未找到具体断言（如 expect(page).toHaveURL(...)），用例无法验证任何行为',
    });
  }

  // 4. wait-for-timeout
  errors.push(
    ...collect(masked, code, /\bwaitForTimeout\s*\(/g, (_m, line, snippet) => ({
      rule: 'wait-for-timeout',
      severity: 'error' as LintSeverity,
      message: '禁止使用 waitForTimeout() 固定等待，请用 expect(...) 自动等待或 waitFor 条件等待',
      line,
      snippet,
    })),
  );

  // 5. brittle-selector
  for (const { selector, index } of extractSelectors(withoutComments)) {
    if (isBrittleSelector(selector)) {
      errors.push({
        rule: 'brittle-selector',
        severity: 'error',
        message: `易碎定位器：locator('${selector.slice(0, 60)}')，请改用 getByRole / getByLabel / getByPlaceholder / getByTestId / getByText`,
        line: lineOf(withoutComments, index),
        snippet: snippetAt(code, index),
      });
    }
  }

  // 6. debug-leftover
  warnings.push(
    ...collect(masked, code, /\bconsole\s*\.\s*(log|debug|info|warn|error)\s*\(/g, (_m, line, snippet) => ({
      rule: 'debug-leftover',
      severity: 'warn' as LintSeverity,
      message: '遗留 console 调用，请删除',
      line,
      snippet,
    })),
  );
  warnings.push(
    ...collect(masked, code, /\bdebugger\b/g, (_m, line, snippet) => ({
      rule: 'debug-leftover',
      severity: 'warn' as LintSeverity,
      message: '遗留 debugger 语句，请删除',
      line,
      snippet,
    })),
  );

  // 7. unknown-testid（仅在提供契约时启用）
  const contractTestIds = options.contractTestIds;
  if (contractTestIds && contractTestIds.size > 0) {
    const rx = /getByTestId\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(withoutComments)) !== null) {
      const testId = m[1]!;
      if (!contractTestIds.has(testId)) {
        warnings.push({
          rule: 'unknown-testid',
          severity: 'warn',
          message: `testid "${testId}" 未在契约 contract.json 中声明，建议扩充契约或改用已有元素`,
          line: lineOf(withoutComments, m.index),
          snippet: snippetAt(code, m.index),
        });
      }
    }
  }

  // v0.7.0 新增：应用用户配置覆盖（severity 提升 / 降级 / off 禁用）
  return applyOverrides({ errors, warnings }, options.overrides);
}

/**
 * 应用 `.specmint/lint-rules.json` 的 severity 覆盖。
 *
 * 语义：
 * - 'off' → 完全丢弃该 issue
 * - 'warn' → issue.severity 强制为 warn，重新归桶
 * - 'error' → issue.severity 强制为 error，重新归桶
 * - 未在 overrides 中列出 → 保持原 severity 与桶
 *
 * 校验：
 * - overrides 中出现未知 rule id → logger.warn 后忽略该 id（不影响其他规则）
 */
function applyOverrides(
  result: { errors: LintIssue[]; warnings: LintIssue[] },
  overrides: LintRulesOverrides | undefined,
): { errors: LintIssue[]; warnings: LintIssue[] } {
  if (!overrides || Object.keys(overrides).length === 0) {
    return result;
  }

  const knownSet = new Set(KNOWN_RULE_IDS);
  const unknownIds: string[] = [];

  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];

  for (const issue of result.errors) {
    const ovr = overrides[issue.rule];
    if (ovr === undefined) {
      errors.push(issue);
      continue;
    }
    if (ovr === 'off') continue;
    if (ovr === 'warn') {
      warnings.push({ ...issue, severity: 'warn' });
    } else {
      // 'error'
      errors.push({ ...issue, severity: 'error' });
    }
  }
  for (const issue of result.warnings) {
    const ovr = overrides[issue.rule];
    if (ovr === undefined) {
      warnings.push(issue);
      continue;
    }
    if (ovr === 'off') continue;
    if (ovr === 'error') {
      errors.push({ ...issue, severity: 'error' });
    } else {
      // 'warn'
      warnings.push({ ...issue, severity: 'warn' });
    }
  }

  // 还要主动扫描 overrides 中"未触发的规则 id"——如果它们不在 KNOWN_RULE_IDS 中也是 unknown
  const triggeredIds = new Set<string>();
  for (const issue of result.errors) triggeredIds.add(issue.rule);
  for (const issue of result.warnings) triggeredIds.add(issue.rule);
  for (const key of Object.keys(overrides)) {
    if (!knownSet.has(key) && !triggeredIds.has(key)) {
      unknownIds.push(key);
    }
  }

  if (unknownIds.length > 0) {
    logger.warn(
      `lint 覆盖包含未知规则 id：${[...new Set(unknownIds)].join(', ')}（将被忽略）`,
    );
  }

  return { errors, warnings };
}

/**
 * 校验单个 spec 文件，包装为 LintResult（带 file 字段与 ok 汇总）。
 */
export function lintSpecFile(file: string, code: string, options: LintOptions = {}): LintResult {
  const { errors, warnings } = lintSpecCode(code, options);
  return { ok: errors.length === 0, file, errors, warnings };
}

/**
 * 读取项目契约，返回 testId 集合（供 unknown-testid 规则使用）。
 * 无契约 / 契约为空时返回 null（跳过该规则）。
 */
export function loadContractTestIds(cwd: string): ReadonlySet<string> | null {
  const contract = loadContract(cwd);
  if (!contract || contract.elements.length === 0) return null;
  const ids = new Set<string>();
  for (const el of contract.elements) {
    if (el.testId) ids.add(el.testId);
  }
  return ids.size > 0 ? ids : null;
}
