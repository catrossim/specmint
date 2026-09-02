import { realpathSync } from 'node:fs';
import { relative as pathRelative, resolve as pathResolve } from 'node:path';
import { runTests } from '../runner/executor.js';
import { loadConfig } from '../config.js';
import { createStores } from '../store/index.js';
import { ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { Priority, ReviewVerdict } from '../store/types.js';
import type { CaseStore } from '../store/index.js';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 用例 → Playwright positional arg（对测试文件完整路径做正则匹配）。
 * 用完整 specPath（相对 cwd、正斜杠）+ 逐字符转义 + `$` 锚定：
 * - 完整路径区分嵌套同名：`login-success` 与 `auth/login-success` 并存时互不串扰；
 * - 转义避免路径中的 `.` 被当成通配符误命中相邻文件；
 * - `$` 锚定避免前缀同名路径被误命中。
 */
const specPathToPattern = (specPath: string): string => `${escapeRegExp(specPath)}$`;

/**
 * 按 verdict 卡口过滤用例名列表。
 *
 * 替代各处散落的 verdict 过滤循环（全量跑 / pattern 单名 / grep 派生），
 * 收敛为唯一入口，避免以后再出现「某条派生分支漏过滤」的同类 bug。
 *
 * 找不到的 name（caseStore 里没有）按 verdict=pending 处理，会被 blockedSet 过滤。
 */
function applyVerdictGate(
  names: string[],
  caseStore: CaseStore,
  blockedSet: Set<ReviewVerdict>,
): { kept: string[]; skipped: Array<{ name: string; verdict: ReviewVerdict }> } {
  const allByName = new Map(caseStore.list({}).map((m) => [m.name, m]));
  const skipped: Array<{ name: string; verdict: ReviewVerdict }> = [];
  const kept: string[] = [];
  for (const name of names) {
    const m = allByName.get(name);
    const verdict = (m?.reviewVerdict ?? 'pending') as ReviewVerdict;
    if (blockedSet.has(verdict)) skipped.push({ name, verdict });
    else kept.push(name);
  }
  return { kept, skipped };
}

export interface RunOptions {
  browser?: string;
  headed?: boolean;
  ui?: boolean;
  debug?: boolean;
  workers?: string;
  retries?: string;
  grep?: string;
  /**
   * spec 文件路径列表（Playwright 多个 positional arg，按文件路径正则匹配）。
   * 由 verdict gate 派生分支设置（全量级 / pattern 多匹配 / --priority / --auth / --module / --group）。
   * 内部使用，CLI 不直接接收。
   */
  patterns?: string[];
  priority?: Priority[];
  /** CLI --module <m>：按用例 meta.module 精确过滤 */
  module?: string;
  /** CLI --group <g>：按用例 meta.group（或 name 前缀）精确过滤 */
  group?: string;
  header?: string[];
  storageState?: string;
  /** CLI --auth <name> */
  authName?: string;
  /** CLI --no-auth */
  noAuth?: boolean;
  /** CLI --config <path>：显式指定自定义 Playwright 配置（默认走包内） */
  configPath?: string;
  json?: boolean;
  /** CLI --label <slug>：批次语义标签 */
  label?: string;
  /** P1：review verdict 卡口标志（与 config.review 段叠加生效） */
  includePending?: boolean;
  includeNeedsFix?: boolean;
  includeRejected?: boolean;
  /** 强制跳过 verdict 检查；单条用例生效时也关闭 warning */
  force?: boolean;
  /** 关闭 verdict 卡口（等价 requireBeforeRun=false） */
  noRequireReview?: boolean;
}

export async function runCommand(
  pattern: string | undefined,
  options: RunOptions,
): Promise<void> {
  // realpath 化以解决 macOS 上 /tmp → /private/tmp 这类软链导致的 pathRelative 跨根失败：
  // caseStore 的 m.specPath 是基于 cwd 归一化的，用户直传的绝对路径若未经过同一归一化，
  // 会造成 m.specPath 与 gate 反查的 rel 永远不相等（看似绝对路径却提示"不在库中"）。
  const cwd = realpathSync(process.cwd());
  const config = loadConfig(cwd);
  const { caseStore, storage } = createStores(cwd);

  const workers = options.workers !== undefined ? parseInt(options.workers, 10) : undefined;
  const retries = options.retries !== undefined ? parseInt(options.retries, 10) : undefined;

  // P1：verdict 卡口预处理（计算 blocked 集合）
  const reviewCfg = config.review;
  const gateEnabled =
    !!reviewCfg?.requireBeforeRun && !options.noRequireReview && !options.force;
  const blockedSet = new Set<ReviewVerdict>();
  if (gateEnabled) {
    for (const v of reviewCfg!.blockedOnRun) blockedSet.add(v);
    if (options.includePending) blockedSet.delete('pending');
    if (options.includeNeedsFix) blockedSet.delete('needs-fix');
    if (options.includeRejected) blockedSet.delete('rejected');
  }

  // P1：全量跑分支的 verdict 卡口（无 pattern / 无 grep / 无 --priority / 无 --auth 时）
  // 之前三个分支（pattern 单名 / grep 派生 / 直接文件路径）都覆盖了 verdict 卡口，
  // 但裸 `specmint run` 漏了：这里从全量用例派生 patterns（spec 文件路径列表），
  // 确保 pending/needs-fix/rejected 不被跑。
  //
  // 关键：用 `options.patterns`（spec 文件路径列表）而不是 `options.grep` 传递 case 名列表，
  // 因为 Playwright 的 `--grep` 匹配的是测试 full title（`describe > test`），
  // 而 spec.ts 里的标题是人类可读的场景名，跟 case 内部名（kebab-case）不是同一回事，
  // 原来传 case 名做 grep 永远匹配不到，会在所有平台（不只是 Windows）报 "No tests found"。
  // positional arg 才是按文件路径正则匹配的，跟 `<casesDir>/<name>.spec.ts` 一一对应，稳。
  // pattern 的具体格式见文件顶层的 specPathToPattern。

  if (!pattern && !options.grep && !options.patterns && gateEnabled) {
    const allItems = caseStore.list({});
    const { kept, skipped } = applyVerdictGate(
      allItems.map((m) => m.name),
      caseStore,
      blockedSet,
    );
    if (kept.length === 0) {
      const verdicts = Array.from(new Set(skipped.map((s) => s.verdict)));
      logger.warn(
        `[review gate] 全部 ${allItems.length} 条用例都被 verdict 过滤跳过（verdicts: ${verdicts.join(', ')}）`,
      );
      logger.warn(
        `  用 --include-pending / --include-needs-fix / --include-rejected 放宽过滤，或 --force 关闭卡口`,
      );
      process.exitCode = ExitCode.NOT_FOUND;
      return;
    }
    const keptSet = new Set(kept);
    options.patterns = allItems
      .filter((m) => keptSet.has(m.name))
      .map((m) => specPathToPattern(m.specPath));
    if (skipped.length > 0 && !options.json) {
      const preview = skipped
        .slice(0, 5)
        .map((s) => `${s.name}=${s.verdict}`)
        .join(', ');
      logger.warn(
        `[review gate] 跳过 ${skipped.length} 条（verdict 被过滤）：${preview}${skipped.length > 5 ? ' ...' : ''}`,
      );
    }
  }

  let resolvedPattern: string | undefined;
  // 单名派生分支已在分支内完成 verdict 判定（blocked 不会到达、非 approved 已提示），
  // 下方"单文件模式"gate 对该场景直接跳过，避免按文件名反查时嵌套同名 find 撞车
  let singleFileGateDone = false;
  if (pattern) {
    if (pattern.endsWith('.ts')) {
      // 单文件路径（含 .spec.ts / 其他 .ts）：直接交给 playwright；
      // verdict 卡口由下方 "单文件模式" 段（resolvedPattern + !grep）按 specPath 查 verdict。
      // Windows 反斜杠归一化：regex 里 `\a` 等是无效转义（JS RegExp 中按字面处理，但路径分隔符
      // 会与 specPath 的正斜杠不一致导致匹配失败），统一转正斜杠，三平台行为一致
      resolvedPattern = pattern.replace(/\\/g, '/');
    } else {
      // 任意非 .ts 结尾的 pattern（含 / 的目录/路径前缀或纯名前缀）：
      // 统一走 caseStore.list 派生，与纯名前缀一致地过 verdict gate（list 同时应用 module/group 过滤）。
      // 修复点：含 / 的目录路径（如 "classes/"）原先被 fast-path 直接当作文件路径，
      // 导致下方 "单文件模式" gate 找不到 matchCandidate 而被静默跳过，verdict 卡口失效。
      const rawMatches = caseStore.list({
        pattern,
        ...(options.module ? { module: options.module } : {}),
        ...(options.group ? { group: options.group } : {}),
      });
      const matches = gateEnabled
        ? (() => {
            const { kept } = applyVerdictGate(
              rawMatches.map((m) => m.name),
              caseStore,
              blockedSet,
            );
            const keptSet = new Set(kept);
            return rawMatches.filter((m) => keptSet.has(m.name));
          })()
        : rawMatches;
      if (matches.length === 0) {
        if (gateEnabled && rawMatches.length > 0) {
          const verdicts = Array.from(
            new Set(rawMatches.map((m) => m.reviewVerdict ?? 'pending')),
          );
          logger.warn(
            `[review gate] 与 "${pattern}" 匹配的 ${rawMatches.length} 条用例全部被 verdict 过滤跳过（verdicts: ${verdicts.join(', ')}）`,
          );
          logger.warn(
            `  用 --include-pending / --include-needs-fix / --include-rejected 放宽过滤，或 --force 关闭卡口`,
          );
        } else {
          const extra: string[] = [];
          if (options.module) extra.push(`module=${options.module}`);
          if (options.group) extra.push(`group=${options.group}`);
          logger.warn(
            `未找到与 "${pattern}" 匹配的用例${extra.length ? `（${extra.join(', ')}）` : ''}`,
          );
        }
        process.exitCode = ExitCode.NOT_FOUND;
        return;
      }
      if (matches.length === 1) {
        const match = matches[0]!;
        // 完整 specPath（正斜杠、相对 cwd）+ 转义 + `$` 锚定：
        // 与 auth/login-success 等嵌套同名用例互不串扰，`.` 不会被当成 regex 通配符
        resolvedPattern = specPathToPattern(match.specPath);
        // verdict 已在上方 matches 过滤时检查过（blocked 的根本到不了这里）；
        // 这里内联"非 approved 提示"，并标记跳过下方"单文件模式"gate 的反查
        if (gateEnabled) {
          const verdict = (match.reviewVerdict ?? 'pending') as ReviewVerdict;
          if (verdict !== 'approved' && !options.json) {
            logger.warn(
              `[run] ${match.name} verdict=${verdict}（非 approved 但已通过过滤，仍执行；建议尽快标 approved 或 needs-fix）`,
            );
          }
        }
        singleFileGateDone = true;
      } else {
        // 多匹配：用 spec 文件路径列表（positional arg）而不是 grep 传 case 名，
        // 原因见全量跑分支的注释（grep 只匹配测试 full title，跟 case 内部名不是一回事）。
        resolvedPattern = undefined;
        if (!options.grep && !options.patterns) {
          options.patterns = matches.map((m) => specPathToPattern(m.specPath));
        }
      }
    }
  }

  // 优先级 / auth 过滤（在 verdict 过滤前完成，确保 options.patterns 派生自最终候选集）
  if (options.priority && options.priority.length > 0 && !options.grep && !options.patterns && !pattern) {
    const items = caseStore.list({ priority: options.priority });
    if (items.length === 0) {
      logger.warn(`没有匹配 priority=${options.priority.join(',')} 的用例`);
      process.exitCode = ExitCode.NOT_FOUND;
      return;
    }
    // verdict 卡口：与全量跑分支保持一致，直接在分支内过滤
    const { kept, skipped } = gateEnabled
      ? applyVerdictGate(items.map((m) => m.name), caseStore, blockedSet)
      : { kept: items.map((m) => m.name), skipped: [] };
    if (kept.length === 0) {
      logger.warn(
        `[review gate] priority=${options.priority.join(',')} 匹配 ${items.length} 条全部被 verdict 过滤跳过`,
      );
      process.exitCode = ExitCode.NOT_FOUND;
      return;
    }
    const keptSet = new Set(kept);
    options.patterns = items
      .filter((m) => keptSet.has(m.name))
      .map((m) => specPathToPattern(m.specPath));
    if (skipped.length > 0 && !options.json) {
      const preview = skipped
        .slice(0, 5)
        .map((s) => `${s.name}=${s.verdict}`)
        .join(', ');
      logger.warn(
        `[review gate] 跳过 ${skipped.length} 条（verdict 被过滤）：${preview}${skipped.length > 5 ? ' ...' : ''}`,
      );
    }
  }

  if (options.authName && !options.grep && !options.patterns && !pattern) {
    const items = caseStore.list({ auth: options.authName });
    if (items.length === 0) {
      logger.warn(`没有匹配 auth=${options.authName} 的用例`);
      process.exitCode = ExitCode.NOT_FOUND;
      return;
    }
    // verdict 卡口：与全量跑分支保持一致，直接在分支内过滤
    const { kept, skipped } = gateEnabled
      ? applyVerdictGate(items.map((m) => m.name), caseStore, blockedSet)
      : { kept: items.map((m) => m.name), skipped: [] };
    if (kept.length === 0) {
      logger.warn(
        `[review gate] auth=${options.authName} 匹配 ${items.length} 条全部被 verdict 过滤跳过`,
      );
      process.exitCode = ExitCode.NOT_FOUND;
      return;
    }
    const keptSet = new Set(kept);
    options.patterns = items
      .filter((m) => keptSet.has(m.name))
      .map((m) => specPathToPattern(m.specPath));
    if (skipped.length > 0 && !options.json) {
      const preview = skipped
        .slice(0, 5)
        .map((s) => `${s.name}=${s.verdict}`)
        .join(', ');
      logger.warn(
        `[review gate] 跳过 ${skipped.length} 条（verdict 被过滤）：${preview}${skipped.length > 5 ? ' ...' : ''}`,
      );
    }
  }
  if (options.authName && !options.storageState && !options.noAuth) {
    options.storageState = `.specmint/auth/storage/${options.authName}.json`;
  }

  // 模块 / group 过滤（无 pattern 时派生 patterns；与 --priority / --authName 一致）
  if ((options.module || options.group) && !options.grep && !options.patterns && !pattern) {
    const items = caseStore.list({
      ...(options.module ? { module: options.module } : {}),
      ...(options.group ? { group: options.group } : {}),
    });
    if (items.length === 0) {
      const extra: string[] = [];
      if (options.module) extra.push(`module=${options.module}`);
      if (options.group) extra.push(`group=${options.group}`);
      logger.warn(`没有匹配 ${extra.join(', ')} 的用例`);
      process.exitCode = ExitCode.NOT_FOUND;
      return;
    }
    // verdict 卡口：与全量跑分支保持一致，直接在分支内过滤
    const { kept, skipped } = gateEnabled
      ? applyVerdictGate(items.map((m) => m.name), caseStore, blockedSet)
      : { kept: items.map((m) => m.name), skipped: [] };
    if (kept.length === 0) {
      const extra: string[] = [];
      if (options.module) extra.push(`module=${options.module}`);
      if (options.group) extra.push(`group=${options.group}`);
      logger.warn(
        `[review gate] ${extra.join(', ')} 匹配 ${items.length} 条全部被 verdict 过滤跳过`,
      );
      process.exitCode = ExitCode.NOT_FOUND;
      return;
    }
    const keptSet = new Set(kept);
    options.patterns = items
      .filter((m) => keptSet.has(m.name))
      .map((m) => specPathToPattern(m.specPath));
    if (skipped.length > 0 && !options.json) {
      const preview = skipped
        .slice(0, 5)
        .map((s) => `${s.name}=${s.verdict}`)
        .join(', ');
      logger.warn(
        `[review gate] 跳过 ${skipped.length} 条（verdict 被过滤）：${preview}${skipped.length > 5 ? ' ...' : ''}`,
      );
    }
  }

  // P1：options.patterns 派生场景下的 verdict 过滤（兜底，确保即使有新分支漏过滤也不会跑 blocked 用例）
  // 注：各分支（priority/auth/module/group/全量跑/pattern 多匹配）已经在分支内做了 verdict 过滤，
  // 这里再兜一道：如果 options.patterns 被某条新分支设置后忘了过滤，至少还能在这里被拦下。
  // pattern 由 specPathToPattern(specPath) 生成（完整路径 + 逐字符转义 + `$` 锚定），与 specPath
  // 一一对应：这里按 specPath 精确反查 verdict，不做字符串反解（反解转义后的 regex 既复杂又易错）。
  // 不在用例库中的 pattern（未来分支传入的非常规格式）原样保留，由 Playwright 自行匹配。
  if (gateEnabled && options.patterns && options.patterns.length > 0) {
    const patternSet = new Set(options.patterns);
    const blockedPatterns = new Set<string>();
    const skipped: Array<{ name: string; verdict: ReviewVerdict }> = [];
    for (const m of caseStore.list({})) {
      const p = specPathToPattern(m.specPath);
      if (!patternSet.has(p)) continue;
      const verdict = (m.reviewVerdict ?? 'pending') as ReviewVerdict;
      if (blockedSet.has(verdict)) {
        blockedPatterns.add(p);
        skipped.push({ name: m.name, verdict });
      }
    }
    if (blockedPatterns.size > 0) {
      const remaining = options.patterns.filter((p) => !blockedPatterns.has(p));
      if (remaining.length === 0) {
        const verdicts = Array.from(new Set(skipped.map((s) => s.verdict)));
        logger.warn(
          `[review gate] ${options.patterns.length} 条候选用例全部被 verdict 过滤跳过（verdicts: ${verdicts.join(', ')}）`,
        );
        logger.warn(`  用 --include-pending / --include-needs-fix / --include-rejected 放宽`);
        process.exitCode = ExitCode.NOT_FOUND;
        return;
      }
      options.patterns = remaining;
      if (!options.json) {
        const preview = skipped
          .slice(0, 5)
          .map((s) => `${s.name}=${s.verdict}`)
          .join(', ');
        logger.warn(
          `[review gate] 跳过 ${skipped.length} 条（verdict 被过滤）：${preview}${skipped.length > 5 ? ' ...' : ''}`,
        );
      }
    }
  }

  // P1：单文件模式（用户直传文件路径），按 specPath 查 verdict。
  // 单名派生分支（singleFileGateDone）已内联判定，跳过；本段只处理用户直传 `.ts` 路径的场景。
  // 反查归一化：resolve 成绝对路径再转相对 cwd 的正斜杠形式，兼容绝对路径 / Windows 反斜杠 / `./` 前缀。
  if (gateEnabled && resolvedPattern && !options.grep && !singleFileGateDone) {
    // 用户输入路径也 realpath 一遍（可能与 cwd 不在同一根，见上方 cwd 注释）：
    // 软链上的文件存在时 realpath 成功可消解，不存在时（用户路径打错）保留原 abs 走 endsWith 兜底
    let abs = pathResolve(cwd, resolvedPattern);
    try {
      abs = realpathSync(abs);
    } catch {
      /* 路径不存在/无权限，保留 abs，依赖 endsWith 兜底 */
    }
    const rel = pathRelative(cwd, abs).replace(/\\/g, '/');
    const candidates = caseStore.list({});
    const matchCandidate = candidates.find(
      (m) => m.specPath === rel || m.specPath.endsWith('/' + rel),
    );
    if (matchCandidate) {
      const verdict = (matchCandidate.reviewVerdict ?? 'pending') as ReviewVerdict;
      if (blockedSet.has(verdict)) {
        logger.warn(
          `[review gate] 用例 ${matchCandidate.name} 当前 verdict=${verdict}，已被 config.review.blockedOnRun 过滤。用 --include-* 或 --force 覆盖。`,
        );
        process.exitCode = ExitCode.NOT_FOUND;
        return;
      }
      if (verdict !== 'approved' && !options.json) {
        logger.warn(
          `[run] ${matchCandidate.name} verdict=${verdict}（非 approved 但已通过过滤，仍执行；建议尽快标 approved 或 needs-fix）`,
        );
      }
    } else if (!options.json) {
      logger.info(
        `[review gate] ${resolvedPattern} 不在用例库中（无对应 meta），跳过 verdict 检查`,
      );
    }
  }

  const result = await runTests({
    pattern: resolvedPattern,
    patterns: options.patterns,
    browser: options.browser ?? config.runner.defaultBrowser,
    headed: options.headed,
    ui: options.ui,
    debug: options.debug,
    workers: Number.isFinite(workers) ? workers : undefined,
    retries: Number.isFinite(retries) ? retries : undefined,
    grep: options.grep,
    runnerConfigPath: options.configPath,
    cwd,
    casesDir: storage.casesDir,
    reportsDir: storage.reportsDir,
    configPath: storage.configPath,
    authDir: storage.authDir,
    config,
    auth: {
      headers: options.header && options.header.length > 0 ? options.header : undefined,
      storageState: options.storageState,
      noAuth: options.noAuth === true,
    },
    label: options.label,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: result.exitCode === 0, ...result }, null, 2) + '\n');
  } else {
    logger.info(`runId: ${result.runId}`);
    logger.info(`status: ${result.status}`);
    logger.info(`exitCode: ${result.exitCode}`);
  }

  if (result.exitCode !== 0) {
    process.exitCode = ExitCode.TEST_FAILED;
  }
}
