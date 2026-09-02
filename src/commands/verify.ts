/**
 * verify 子命令：spec 静态可达性校验（v0.7.0 新增）
 *
 * 定位：lint 之上、run 之下 —— 拦截「编译都过、lint 不报，但跑起来一定挂」的用例。
 *
 * 退出码：
 * - 0 = OK
 * - VERIFY_FAILED (15) = 有 verify error
 *
 * 与 lint 的关系：
 * - lint 抓代码风格（断言 / waitForTimeout / 易碎定位器），severity 含 warn/error
 * - verify 抓可达性（编译错 / 空 test / 定位器 vs 契约），severity 全部为 error
 * - 两套规则共享同一 spec 文件，互不冲突，可独立运行
 * - verify 不启动浏览器
 *
 * 与 run 的关系：
 * - verify 是「跑之前」的静态检查，run 是「跑起来」的动态执行
 * - verify 通过的用例，run 仍可能因环境因素失败；verify 失败的用例，run 几乎必失败
 */
import { readFileSync } from 'node:fs';
import { relative as pathRelative } from 'node:path';
import { CliError, ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { createStores } from '../store/index.js';
import { resolveSpecTargets } from '../utils/spec-files.js';
import { loadContractTestIds } from '../utils/spec-lint.js';
import { verifySpecCode, type VerifyIssue } from '../utils/spec-verify.js';

export interface VerifyCommandOptions {
  /** 是否以 JSON 形式输出（agent / CI 友好） */
  json?: boolean;
}

interface VerifyFileResult {
  file: string;
  ok: boolean;
  issues: VerifyIssue[];
}

interface VerifySummary {
  ok: boolean;
  count: number;
  totalIssues: number;
  contractTestIds: number;
  files: VerifyFileResult[];
}

export async function verifyCommand(
  target: string | undefined,
  options: VerifyCommandOptions,
): Promise<void> {
  const cwd = process.cwd();
  const { storage } = createStores(cwd);

  const files = resolveSpecTargets(target, {
    casesDir: storage.casesDir,
    cwd,
  });

  if (files.length === 0) {
    const message = target
      ? `没有匹配 "${target}" 的 spec 文件`
      : '用例库为空（.specmint/cases/ 下没有 .spec.ts）';
    if (options.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, count: 0, totalIssues: 0, files: [] }, null, 2) + '\n',
      );
    } else {
      logger.info(message);
    }
    return;
  }

  const contractTestIds = loadContractTestIds(cwd);

  const results: VerifyFileResult[] = [];
  for (const file of files) {
    const rel = toRel(cwd, file);
    let issues: VerifyIssue[] = [];
    try {
      const code = readFileSync(file, 'utf-8');
      issues = verifySpecCode(code, { contractTestIds });
    } catch (err) {
      // 读取失败属于 IO 错误，不归 verify issue；走 IO_ERROR 退出码更准确
      throw new CliError({
        code: ExitCode.IO_ERROR,
        message: `读取 spec 文件失败：${(err as Error).message}`,
        hint: `检查文件权限：${file}`,
      });
    }
    results.push({ file: rel, ok: issues.length === 0, issues });
  }

  const totalIssues = results.reduce((n, r) => n + r.issues.length, 0);
  const ok = totalIssues === 0;
  const summary: VerifySummary = {
    ok,
    count: results.length,
    totalIssues,
    contractTestIds: contractTestIds?.size ?? 0,
    files: results,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    printHuman(results, contractTestIds);
  }

  if (!ok) {
    process.exitCode = ExitCode.VERIFY_FAILED;
  }
}

function printHuman(
  results: VerifyFileResult[],
  contractTestIds: ReadonlySet<string> | null,
): void {
  const dirty = results.filter((r) => r.issues.length > 0);

  if (dirty.length === 0) {
    const hint =
      contractTestIds === null
        ? '（未启用 locator-vs-contract，需有 .specmint/contract.json）'
        : `（已对照契约中的 ${contractTestIds.size} 个 testId）`;
    logger.info(`✓ ${results.length} 个 spec 文件通过 verify${hint}`);
    return;
  }

  for (const r of dirty) {
    process.stdout.write(`\n${r.file}\n`);
    for (const issue of r.issues) {
      const loc = issue.line !== undefined ? `:${issue.line}` : '';
      process.stdout.write(`  ✗ error  ${issue.ruleId}${loc}\n`);
      process.stdout.write(`      ${issue.message}\n`);
      if (issue.snippet) {
        process.stdout.write(`      > ${issue.snippet}\n`);
      }
    }
  }
  logger.info(
    `\n${results.length} 个文件，${dirty.length} 个未通过（error 级）`,
  );
}

function toRel(cwd: string, file: string): string {
  return pathRelative(cwd, file).replace(/\\/g, '/');
}