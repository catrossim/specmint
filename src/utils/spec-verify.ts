/**
 * spec 静态可达性校验（v0.7.0 新增）
 *
 * 定位：lint 之上、run 之下 —— 拦截「编译都过、lint 不报，但跑起来一定挂」的用例。
 *
 * 与 lint 的关系：
 * - lint 抓代码风格（断言 / waitForTimeout / 易碎定位器），severity 包含 warn/error
 * - verify 抓可达性（空 test 体 / 定位器 vs 契约），severity 全部为 error
 * - 两套规则共享同一 spec 文件，互不冲突，可独立运行
 * - verify 不启动浏览器
 *
 * v0.7.0 覆盖两条规则：
 * - `empty-test-body`：test 块体为空，跑起来无任何断言或步骤 → error
 * - `locator-not-in-contract`：getByTestId('x') 中的 x 不在契约 testIds 集合 → error
 *
 * v0.7.0 留白（已知）：
 * - **编译检查**（TS 语法错、import/export 错）：TypeScript 7 移除了程序化
 *   `transpileModule` API（package.json 的 `exports["."]` 现在指向 `./lib/version.cjs`），
 *   改为 LSP client 模式（API 类），引入 `tsc` 子进程会让 verify 变慢且复杂。
 *   v0.7.0 暂不上线 `compile-error` 规则；待 TS 提供兼容的 sync API 后补上（v0.8+ 跟踪）。
 * - 路径可达性（page.goto('/login') 是否真存在该路由）需要 contract.routes 字段
 * - 缺 await 在 page 操作上的检测（编译错足够覆盖）
 */

export type VerifySeverity = 'error';

export type VerifyRuleId =
  | 'empty-test-body'
  | 'locator-not-in-contract';

export interface VerifyIssue {
  ruleId: VerifyRuleId;
  severity: VerifySeverity;
  message: string;
  /** 1-based 行号（基于原始源码） */
  line?: number;
  /** 1-based 列号 */
  column?: number;
  /** 命中行的裁剪片段，便于终端直接定位 */
  snippet?: string;
}

export interface VerifyOptions {
  /**
   * 契约 testId 集合（来自 contract.json）。
   * - 传入 Set：启用 locator-not-in-contract 规则（未在契约内声明的 getByTestId → error）
   * - null / 省略：跳过该规则（无契约时不做无谓告警）
   */
  contractTestIds?: ReadonlySet<string> | null;
}

/**
 * 校验一段 spec.ts 源码，返回 verify 错误列表。
 *
 * 实现取舍：
 * - 空 test 体检测用正则（与 lint 风格一致）
 * - locator-vs-contract 复用与 lint 同一组 getByTestId 提取逻辑，但 severity 强制 error
 */
export function verifySpecCode(
  code: string,
  options: VerifyOptions = {},
): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  issues.push(...emptyBodyCheck(code));
  const contractTestIds = options.contractTestIds;
  if (contractTestIds && contractTestIds.size > 0) {
    issues.push(...locatorVsContract(code, contractTestIds));
  }
  return issues;
}

/** 1) 空 test 体检查：test('x', async () => { }) 这类"啥都没做"的用例 */
function emptyBodyCheck(code: string): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  // 抓 test('xxx', async () => { }) 形式——test(name, asyncFn) 中 asyncFn 体为空
  // 兼容形式：
  //   test('x', async () => {})
  //   test('x', async ({ page }) => {})
  //   test('x', async () => {\n})  跨行
  //   test('x',\n  async () => {}) 形参与 fn 跨行
  // 兼容尾部 ; 与空白
  // 不覆盖 test.describe（它的回调通常是 () => { test('a', ...) } 而非 async）
  // 中间段用 (?:[^()]|\([^()]*\))*? 约束在当前 test(...) 参数列表内（允许一层括号嵌套）：
  //   若用 [\s\S]*?，惰性匹配可跨越整个 test 块，把后续任意位置出现的
  //   「xxx(1, async () => {})」形空回调误判为空 test，且行号指向错误的 test
  const re =
    /\btest\s*\((?:[^()]|\([^()]*\))*?,\s*async\s*(?:\(\s*[^)]*\s*\))?\s*=>\s*\{\s*\}\s*\)\s*;?/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const lineNumber = lineOf(code, m.index);
    const snippet = snippetAt(code, m.index);
    issues.push({
      ruleId: 'empty-test-body',
      severity: 'error',
      message: 'test 块体为空，跑起来无任何断言或步骤',
      line: lineNumber,
      snippet,
    });
  }
  return issues;
}

/** 2) locator vs 契约：getByTestId('x') 中的 x 不在契约声明的 testIds 集合中 */
function locatorVsContract(
  code: string,
  contractTestIds: ReadonlySet<string>,
): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  const re = /\bgetByTestId\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const testId = m[1]!;
    if (!contractTestIds.has(testId)) {
      const lineNumber = lineOf(code, m.index);
      const snippet = snippetAt(code, m.index);
      issues.push({
        ruleId: 'locator-not-in-contract',
        severity: 'error',
        message: `getByTestId('${testId}') 不在契约 contract.json 声明的 testIds 中`,
        line: lineNumber,
        snippet,
      });
    }
  }
  return issues;
}

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
