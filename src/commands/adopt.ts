/**
 * adopt 子命令：纳管已存在的 spec.ts 进入用例库
 *
 * 这是「宿主 agent（skill）写用例 → specmint 管生命周期」的入口。
 *
 * 为什么需要它：`caseStore.list()` 会跳过所有没有 meta.json 的 spec.ts，
 * 而 run 的执行集与 verdict 卡口全部派生自 list()。也就是说，agent 直接把
 * spec.ts 写进 `.specmint/cases/`，specmint 根本看不见它。adopt 就是补上这个缺口。
 *
 * 设计要点：
 * - 只写 meta.json，绝不覆写 spec.ts（代码是用户/agent 的资产）
 * - 纳管前默认跑 lint：error 拒绝纳管，warn 打印但放行
 * - 元数据优先级：CLI 参数 > spec.ts 头部 @specmint 注释 > 路径推导
 * - 幂等：重复 adopt 只补缺失字段，保留裁决历史与运行统计
 * - 审核可信度：已 approved 的用例内容若变更，自动回落 pending
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative as pathRelative } from 'node:path';
import { createStores } from '../store/index.js';
import { loadConfig } from '../config.js';
import { ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { lintSpecCode, loadContractTestIds, type LintIssue } from '../utils/spec-lint.js';
import { loadLintRulesOverrides } from '../utils/lint-plugin.js';
import { caseNameFromSpecPath, resolveSpecTargets } from '../utils/spec-files.js';
import { extractCaseTitle, parseSpecMeta } from '../utils/spec-meta-parse.js';
import type { CaseMeta, Priority } from '../store/types.js';

export interface AdoptOptions {
  priority?: Priority;
  module?: string;
  group?: string;
  tag?: string[];
  ticket?: string[];
  auth?: string;
  description?: string;
  json?: boolean;
  /** 全量覆盖已有 meta 字段（默认只补缺失） */
  force?: boolean;
  /** 跳过 lint 检查 */
  noLint?: boolean;
  /** 内容变更时保留原 verdict，不自动回落 pending */
  keepVerdict?: boolean;
}

interface AdoptedItem {
  name: string;
  priority: string;
  module: string | null;
  group: string | null;
  tags: string[];
  created: boolean;
  metaPath: string;
}

interface RejectedItem {
  name: string;
  file: string;
  errors: LintIssue[];
}

const HASH_LENGTH = 16;

function hashContent(code: string): string {
  // 归一化行尾：CRLF / LF 混合协作时，内容相同的用例必须得到相同哈希，
  // 否则已 approved 的用例会被误判为「内容已变更」而回落 pending
  const normalized = code.replace(/\r\n/g, '\n');
  return createHash('sha256').update(normalized, 'utf-8').digest('hex').slice(0, HASH_LENGTH);
}

export async function adoptCommand(
  target: string | undefined,
  options: AdoptOptions,
): Promise<void> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const { caseStore, storage } = createStores(cwd);

  const files = resolveSpecTargets(target, { casesDir: storage.casesDir, cwd });

  if (files.length === 0) {
    const message = target
      ? `没有匹配 "${target}" 的 spec 文件`
      : '用例库为空（.specmint/cases/ 下没有 .spec.ts）';
    if (options.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, adopted: [], reopened: [], rejected: [], warnings: [] }, null, 2) + '\n',
      );
    } else {
      logger.info(message);
    }
    return;
  }

  const contractTestIds = loadContractTestIds(cwd);
  const overrides = loadLintRulesOverrides(cwd);
  const adopted: AdoptedItem[] = [];
  const reopened: Array<{ name: string; from: string; to: string }> = [];
  const rejected: RejectedItem[] = [];
  const warningIssues: Array<{ name: string; issue: LintIssue }> = [];

  for (const file of files) {
    const rel = pathRelative(cwd, file).replace(/\\/g, '/');
    const name = caseNameFromSpecPath(storage.casesDir, file);

    let code: string;
    try {
      code = readFileSync(file, 'utf-8');
    } catch (err) {
      rejected.push({
        name,
        file: rel,
        errors: [{ rule: 'unreadable', severity: 'error', message: `读取失败：${(err as Error).message}` }],
      });
      continue;
    }

    // 1. lint（默认开启）：error 拒绝纳管，warn 记录后放行
    if (!options.noLint) {
      const { errors, warnings } = lintSpecCode(code, { contractTestIds, overrides });
      if (errors.length > 0) {
        rejected.push({ name, file: rel, errors });
        continue;
      }
      for (const issue of warnings) warningIssues.push({ name, issue });
    }

    // 2. 元数据：CLI > 文件注释 > 路径推导
    const parsed = parseSpecMeta(code);
    const groupFromPath = name.includes('/') ? name.split('/')[0] : undefined;
    const cliGroup = options.group?.trim() || undefined;

    // group 必须与物理目录一致：adopt 不移动文件，冲突时只能报错让用户二选一
    if (cliGroup && groupFromPath && cliGroup !== groupFromPath) {
      rejected.push({
        name,
        file: rel,
        errors: [
          {
            rule: 'group-mismatch',
            severity: 'error',
            message: `--group "${cliGroup}" 与文件所在目录 "${groupFromPath}" 不一致`,
          },
        ],
      });
      continue;
    }
    const group = cliGroup ?? parsed.group ?? groupFromPath;

    const priority = options.priority ?? (parsed.priority as Priority | undefined);
    if (!priority) {
      rejected.push({
        name,
        file: rel,
        errors: [
          {
            rule: 'missing-priority',
            severity: 'error',
            message: '缺少 priority（必须 P0|P1|P2|P3 之一）',
          },
        ],
      });
      continue;
    }

    const description =
      options.description?.trim() ||
      parsed.description ||
      extractCaseTitle(code) ||
      name;

    const tags = mergeList(options.tag, parsed.tags);
    const tickets = mergeList(options.ticket, parsed.linkedTickets);

    // 3. 纳管（只写 meta.json）
    const result = caseStore.adopt(
      {
        name,
        description,
        priority,
        group,
        module: options.module?.trim() || parsed.module,
        linkedTickets: tickets.length > 0 ? tickets : undefined,
        auth: options.auth?.trim() || parsed.auth,
        tags,
        sourceInput: `adopt:${rel}`,
        generation: {
          mode: 'description-only',
          exploredUrl: null,
          selectorPolicy: config.generation.selectorPolicy,
        },
        contentHash: hashContent(code),
      },
      { force: options.force === true, ...(options.keepVerdict ? { keepVerdict: true } : {}) },
    );

    adopted.push({
      name,
      priority,
      module: result.meta.module ?? null,
      group: result.meta.group ?? null,
      tags: result.meta.tags,
      created: result.created,
      metaPath: pathRelative(cwd, result.metaPath).replace(/\\/g, '/'),
    });

    if (result.reopened) {
      reopened.push({ name, from: 'approved', to: 'pending' });
    }
  }

  const ok = rejected.length === 0;

  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok,
          adopted,
          reopened,
          rejected,
          warnings: warningIssues.map(({ name, issue }) => ({ name, rule: issue.rule, message: issue.message, line: issue.line })),
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    printHuman(adopted, reopened, rejected, warningIssues);
  }

  if (!ok) {
    process.exitCode = ExitCode.LINT_FAILED;
  }
}

/** CLI 传值与文件注释值合并（CLI 优先，去重保序） */
function mergeList(cliValues: string[] | undefined, fileValues: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of [...(cliValues ?? []), ...fileValues]) {
    const t = v.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function printHuman(
  adopted: AdoptedItem[],
  reopened: Array<{ name: string; from: string; to: string }>,
  rejected: RejectedItem[],
  warnings: Array<{ name: string; issue: LintIssue }>,
): void {
  for (const item of adopted) {
    const verb = item.created ? '纳管' : '更新';
    const tags = item.tags.length > 0 ? ` [${item.tags.join(', ')}]` : '';
    process.stdout.write(
      `✓ ${verb}  ${item.name}  ${item.priority}  ${item.module ?? '-'}${tags}\n`,
    );
    process.stdout.write(`         meta → ${item.metaPath}\n`);
  }

  for (const item of reopened) {
    logger.warn(
      `⟳ ${item.name} 内容已变更，裁决从 ${item.from} 回落为 ${item.to}（需重新人工审核）`,
    );
  }

  for (const { name, issue } of warnings) {
    const loc = issue.line !== undefined ? `:${issue.line}` : '';
    logger.warn(`⚠ ${name}${loc} ${issue.rule}: ${issue.message}`);
  }

  for (const item of rejected) {
    process.stdout.write(`✗ 拒绝纳管 ${item.name}  (${item.file})\n`);
    for (const issue of item.errors) {
      const loc = issue.line !== undefined ? `:${issue.line}` : '';
      process.stdout.write(`      ${issue.rule}${loc}: ${issue.message}\n`);
    }
  }

  if (adopted.length > 0) {
    logger.info(
      `\n已纳管 ${adopted.length} 条；下一步：specmint review（人工裁决）→ specmint run`,
    );
  }
  if (rejected.length > 0) {
    logger.warn(
      `${rejected.length} 个文件未通过校验；修完后重新 adopt，或用 --no-lint 跳过（不推荐）`,
    );
  }
}
