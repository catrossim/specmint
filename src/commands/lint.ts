/**
 * lint 子命令：spec.ts 静态校验
 *
 * 定位：把「写在 prompt 里求 LLM 遵守」的软约束，变成可执行的硬检查。
 * 与 `adopt` 共用 `utils/spec-lint.ts` 的规则实现（规则只有一份）。
 *
 * 扫描目标支持三种形态：
 * - 不传 target：整个用例库 `.specmint/cases/`
 * - 文件路径 / 目录：直接定位
 * - glob：`.specmint/cases/auth/**\/*.spec.ts`
 *
 * 退出码：有 error → LINT_FAILED(9)；--strict 时 warn 也算失败。
 */
import { readFileSync } from 'node:fs';
import { relative as pathRelative } from 'node:path';
import { createStores } from '../store/index.js';
import { ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { lintSpecFile, loadContractTestIds, type LintIssue, type LintResult } from '../utils/spec-lint.js';
import { loadLintRulesOverrides } from '../utils/lint-plugin.js';
import { resolveSpecTargets } from '../utils/spec-files.js';

export interface LintCommandOptions {
  json?: boolean;
  /** 把 warn 也视为失败（CI 严格模式） */
  strict?: boolean;
}

export async function lintCommand(
  target: string | undefined,
  options: LintCommandOptions,
): Promise<void> {
  const cwd = process.cwd();
  const { storage } = createStores(cwd);

  const files = resolveSpecTargets(target, { casesDir: storage.casesDir, cwd });

  if (files.length === 0) {
    const message = target
      ? `没有匹配 "${target}" 的 spec 文件`
      : '用例库为空（.specmint/cases/ 下没有 .spec.ts）';
    if (options.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, count: 0, errorCount: 0, warningCount: 0, files: [] }, null, 2) + '\n',
      );
    } else {
      logger.info(message);
    }
    return;
  }

  const contractTestIds = loadContractTestIds(cwd);
  const overrides = loadLintRulesOverrides(cwd);

  const results: LintResult[] = [];
  for (const file of files) {
    let code: string;
    try {
      code = readFileSync(file, 'utf-8');
    } catch (err) {
      results.push({
        ok: false,
        file: toRel(cwd, file),
        errors: [
          {
            rule: 'unreadable',
            severity: 'error',
            message: `读取失败：${(err as Error).message}`,
          },
        ],
        warnings: [],
      });
      continue;
    }
    results.push(lintSpecFile(toRel(cwd, file), code, { contractTestIds, overrides }));
  }

  const errorCount = results.reduce((n, r) => n + r.errors.length, 0);
  const warningCount = results.reduce((n, r) => n + r.warnings.length, 0);
  const ok = errorCount === 0 && (!options.strict || warningCount === 0);

  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        { ok, count: results.length, errorCount, warningCount, strict: !!options.strict, files: results },
        null,
        2,
      ) + '\n',
    );
  } else {
    printHuman(results, errorCount, warningCount, !!options.strict);
  }

  if (!ok) {
    process.exitCode = ExitCode.LINT_FAILED;
  }
}

function printHuman(
  results: LintResult[],
  errorCount: number,
  warningCount: number,
  strict: boolean,
): void {
  const dirty = results.filter((r) => r.errors.length > 0 || r.warnings.length > 0);

  if (dirty.length === 0) {
    logger.info(`✓ ${results.length} 个 spec 文件通过校验`);
    return;
  }

  for (const r of dirty) {
    process.stdout.write(`\n${r.file}\n`);
    for (const issue of r.errors) printIssue(r.file, issue, '✗', 'error');
    for (const issue of r.warnings) printIssue(r.file, issue, '⚠', 'warn');
  }

  process.stdout.write('');
  const tail = strict && errorCount === 0 && warningCount > 0
    ? `（--strict：warning 视为失败）`
    : '';
  logger.info(
    `\n${results.length} 个文件：${errorCount} error，${warningCount} warning${tail}`,
  );
  if (errorCount > 0) {
    logger.warn('error 为质量红线，`specmint adopt` 会拒绝纳管；warning 可通过 --strict 收紧');
  }
}

function printIssue(file: string, issue: LintIssue, mark: string, label: string): void {
  const loc = issue.line !== undefined ? `:${issue.line}` : '';
  process.stdout.write(`  ${mark} ${label.padEnd(5)} ${issue.rule}${loc}\n`);
  process.stdout.write(`      ${issue.message}\n`);
  if (issue.snippet) {
    process.stdout.write(`      > ${issue.snippet}\n`);
  }
}

function toRel(cwd: string, file: string): string {
  return pathRelative(cwd, file).replace(/\\/g, '/');
}
