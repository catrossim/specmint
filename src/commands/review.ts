/**
 * specmint review — 人工裁决（人工仲裁）测试用例。
 *
 * 数据落到 `<name>.meta.json` 的 `review` 字段。
 * P1 起 review 升级为执行关卡：
 * - `reviewInteractiveCommand` 默认翻页裁决队列（per-case prompts，与现有 prompt.ts 风格一致）
 * - `run --all` 默认仅跑 verdict=approved（受 config.review 段控制）
 * - `heal` 仅对 verdict=needs-fix 工作
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStores } from '../store/index.js';
import { REVIEW_VERDICTS, type ReviewVerdict } from '../store/types.js';
import { CliError, ExitCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { askText, select } from '../utils/prompt.js';

export interface ReviewSetOptions {
  /** 必填。commander requiredOption 已校验，类型已是 ReviewVerdict | string */
  verdict: ReviewVerdict;
  reviewer?: string;
  /** 空字符串视为显式清空；undefined 保留原有备注 */
  note?: string;
  json?: boolean;
}

export async function reviewSetCommand(name: string, opts: ReviewSetOptions): Promise<void> {
  const cwd = process.cwd();
  const { caseStore } = createStores(cwd);

  if (!opts.verdict) {
    throw new CliError({
      code: ExitCode.USAGE_ERROR,
      message: `--verdict 必填，必须是 ${REVIEW_VERDICTS.join('|')} 之一`,
    });
  }

  const reviewer = opts.reviewer ?? defaultReviewer();
  const reviewedAt = new Date().toISOString();
  const updated = caseStore.updateReview(name, {
    verdict: opts.verdict,
    reviewer,
    reviewedAt,
    note: opts.note,
  });

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ ok: true, case: name, review: updated.review ?? null }, null, 2) + '\n',
    );
    return;
  }

  logger.info(`[case:${name}] review -> ${opts.verdict}（reviewer=${reviewer}）`);
  if (typeof opts.note === 'string' && opts.note.length > 0) {
    logger.info(`  note: ${opts.note}`);
  } else if (opts.note === '') {
    logger.info('  note: (cleared)');
  }
}

export interface ReviewListOptions {
  /** 默认开：仅看 pending */
  pending?: boolean;
  /** 关闭 pending 默认，看全部 */
  all?: boolean;
  /** 按指定 verdict 过滤，与 --pending 互斥 */
  verdict?: ReviewVerdict;
  module?: string;
  group?: string;
  json?: boolean;
}

export async function reviewListCommand(opts: ReviewListOptions): Promise<void> {
  const cwd = process.cwd();
  const { caseStore, storage } = createStores(cwd);

  const items = caseStore.list({
    module: opts.module,
    group: opts.group,
  });

  // 归一化：缺失视为 'pending'
  const effective = items.map((it) => ({
    ...it,
    reviewVerdict: (it.reviewVerdict ?? 'pending') as ReviewVerdict,
  }));

  const onlyPending = opts.verdict === undefined && !opts.all;
  const onlyVerdict = opts.verdict;

  const filtered = effective.filter((r) => {
    if (onlyVerdict !== undefined) return r.reviewVerdict === onlyVerdict;
    if (onlyPending) return r.reviewVerdict === 'pending';
    return true;
  });

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        { ok: true, root: storage.root, count: filtered.length, items: filtered },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (filtered.length === 0) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { ok: true, root: storage.root, count: 0, items: [] },
          null,
          2,
        ) + '\n',
      );
      return;
    }
    const emptyMsg =
      onlyVerdict !== undefined
        ? `没有 verdict=${onlyVerdict} 的用例。`
        : onlyPending
          ? '当前没有待裁决（pending）的用例。试试 `specmint review list --all` 查看全部。'
          : '用例库为空。';
    logger.info(emptyMsg);
    return;
  }

  const nameW = Math.max(4, ...filtered.map((r) => r.name.length));
  const prioW = Math.max(3, ...filtered.map((r) => (r.priority ?? '-').length));
  const verdictW = Math.max(6, ...filtered.map((r) => r.reviewVerdict.length));

  const header = ['NAME'.padEnd(nameW), 'PRI'.padEnd(prioW), 'REVIEW'.padEnd(verdictW)];
  const lines: string[] = [header.join('  '), '-'.repeat(header.join('  ').length)];

  for (const r of filtered) {
    lines.push(
      [r.name.padEnd(nameW), (r.priority ?? '-').padEnd(prioW), r.reviewVerdict.padEnd(verdictW)].join('  '),
    );
  }
  process.stdout.write(lines.join('\n') + '\n');

  const total = effective.length;
  const pendingCount = effective.filter((r) => r.reviewVerdict === 'pending').length;
  const tail =
    onlyPending
      ? `\n${filtered.length}/${total} 条，全部是 pending。查看已裁决？用 \`specmint review list --all\`。`
      : `\n${filtered.length}/${total} 条（pending ${pendingCount}）。仅看 pending？去掉 --all / --verdict。`;
  process.stdout.write(tail + '\n');
}

// -------------------------------------------------------------------------
// P1：REPL + show
// -------------------------------------------------------------------------

export interface ReviewInteractiveOptions {
  /** 只过这 N 条（generate 末尾挂点用）。未传则用 review list 默认（pending 全部）。 */
  cases?: string[];
  /** 当 cases 指定时，可同时过滤 verdict；未传则保留全部（含已 approved）。 */
  all?: boolean;
  /** REPL 内对单条用例显示的 spec.ts 最大行数（默认 30） */
  previewLines?: number;
  json?: boolean;
}

const VERDICT_OPTIONS = [
  { value: 'approved', description: '可纳入回归，下次 run 默认执行' },
  { value: 'needs-fix', description: '人工/agent 需要重写 spec.ts' },
  { value: 'rejected', description: '废弃或重写，不参与运行' },
  { value: 'skipped', description: '保留用例，暂不裁决' },
  { value: 'quit', description: '退出 REPL，剩余待下次处理' },
] as const;

/**
 * REPL：逐条翻页裁决。
 *
 * 行为约定：
 * - TTY 时进入循环；非 TTY 时拒绝进入（不批量默标 approved，避免 race）
 * - 默认显示全部 pending；`--cases a,b,c` 时只过子集
 * - 每条：分隔条 + 名称/描述/优先级/当前裁决 + spec.ts 前 N 行
 * - `select()` 出 5 个 verdict 选项（approved/needs-fix/rejected/skipped/quit）
 * - needs-fix 和 rejected 后再 `askText` 收 note
 * - skipped 不写 meta（保持原状态，便于重审）
 * - quit 立即退出
 */
export async function reviewInteractiveCommand(
  cwd: string,
  opts: ReviewInteractiveOptions = {},
): Promise<void> {
  const { caseStore, storage } = createStores(cwd);

  if (!isInteractive()) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: false,
            reason: 'non-interactive-terminal',
            hint: '请用 `specmint review set <name> --verdict ...` 或 `specmint review list` 查看队列',
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }
    logger.warn('当前终端不是交互式 TTY，跳过 REPL。请用 `specmint review set/list` 手动处理。');
    return;
  }

  const previewLines = opts.previewLines ?? 30;

  // 1) 收集候选：默认 pending 全部；--cases 指定时只过这 N 条
  let queue;
  if (opts.cases && opts.cases.length > 0) {
    const summaries = caseStore.list({});
    const set = new Set(opts.cases);
    queue = summaries.filter((s) => set.has(s.name));
  } else {
    queue = caseStore.list({});
  }

  const effective = queue.map((it) => ({
    ...it,
    reviewVerdict: (it.reviewVerdict ?? 'pending') as ReviewVerdict,
  }));

  const onlyPending = !opts.all;
  const filtered = effective.filter((r) => (onlyPending ? r.reviewVerdict === 'pending' : true));

  if (filtered.length === 0) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { ok: true, root: storage.root, processed: 0, skipped: 0, remaining: 0, items: [] },
          null,
          2,
        ) + '\n',
      );
      return;
    }
    logger.info(opts.cases?.length ? '指定用例都已审过，没有 pending 可过。' : '当前没有待裁决（pending）的用例。');
    return;
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        { ok: false, reason: 'json-not-supported-in-repl', hint: 'JSON 输出请改用 `specmint review list --json`' },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  const reviewer = defaultReviewer();
  logger.info(
    `▸ 进入裁决队列 · 候选人: ${filtered.length} 条 · 裁决人: ${reviewer}\n` +
      `  提示: 直接回车 = 默认 approved · 输入 q 退出 · 剩余用例下次再过\n`,
  );

  let processed = 0;
  let skipped = 0;

  for (let i = 0; i < filtered.length; i++) {
    const item = filtered[i]!;
    const verdict = await promptForVerdict(item, i, filtered.length, previewLines);
    if (verdict === null) {
      logger.info(`\n已退出。已裁决 ${processed} 条，跳过 ${skipped} 条，剩余 ${filtered.length - i} 条待下次。`);
      return;
    }
    if (verdict === 'skip-keep') {
      skipped++;
      process.stdout.write(`  · 跳过（保持原状态）\n\n`);
      continue;
    }
    if (verdict === 'skipped') {
      skipped++;
      logger.info(`  [${i + 1}/${filtered.length}] · ${item.name} · skipped（保留，下次再过）`);
      process.stdout.write('\n');
      continue;
    }

    // approved / needs-fix / rejected —— 写到 meta
    let note: string | undefined;
    if (verdict === 'needs-fix' || verdict === 'rejected') {
      const ans = await askText(
        `备注（${verdict === 'needs-fix' ? '要修什么' : '为什么拒绝'}）`,
        verdict === 'needs-fix' ? '例如：断言用了价格计算，未覆盖汇率' : '例如：与 X 用例重复',
      );
      note = ans.length > 0 ? ans : undefined;
      // 不强制 note 也允许：留空就走 reviewer 自动标记
    }

    try {
      caseStore.updateReview(item.name, {
        verdict,
        reviewer,
        reviewedAt: new Date().toISOString(),
        note,
      });
    } catch (err) {
      logger.warn(`[case:${item.name}] 写入 review 失败：${(err as Error).message}`);
      skipped++;
      continue;
    }

    processed++;
    logger.info(
      `  ✓ [${i + 1}/${filtered.length}] · ${item.name} · ${verdict}` +
        (note ? ` · ${truncate(note, 60)}` : ''),
    );
    process.stdout.write('\n');
  }

  logger.info(`✓ 裁决完成 · 已写 ${processed} 条 · 跳过 ${skipped} 条 · 剩余 ${filtered.length - processed - skipped} 条 pending`);
}

/**
 * 显示单条用例的 review 状态，附 meta 摘要。
 */
export interface ReviewShowOptions {
  json?: boolean;
}

export async function reviewShowCommand(
  name: string,
  opts: ReviewShowOptions = {},
): Promise<void> {
  const cwd = process.cwd();
  const { caseStore } = createStores(cwd);
  const meta = caseStore.get(name);
  if (!meta) {
    throw new CliError({ code: ExitCode.NOT_FOUND, message: `用例 ${name} 不存在` });
  }

  const review = meta.review ?? { verdict: 'pending' as ReviewVerdict };
  const effectiveVerdict: ReviewVerdict = review.verdict;

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          case: name,
          description: meta.description,
          priority: meta.priority,
          review: meta.review ?? null,
          effectiveVerdict,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  logger.info(`[case:${name}] ${meta.description}`);
  logger.info(`  priority  : ${meta.priority ?? '-'}`);
  logger.info(`  verdict   : ${effectiveVerdict}` + (effectiveVerdict === 'pending' ? '（缺失 review 字段，视为 pending）' : ''));
  if (review.reviewer) logger.info(`  reviewer  : ${review.reviewer}`);
  if (review.reviewedAt) logger.info(`  reviewedAt: ${review.reviewedAt}`);
  if (review.note) logger.info(`  note      : ${review.note}`);
}

// -------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------

/**
 * 单条用例的 REPL 提示：渲染上下文 + 询问 verdict。
 * 返回 verdict 字符串，或 'skip-keep' 表示显式 skip 但保留状态，或 null 表示退出。
 */
async function promptForVerdict(
  item: ReturnType<typeof toCaseItem>,
  index: number,
  total: number,
  previewLines: number,
): Promise<ReviewVerdict | 'skip-keep' | null> {
  process.stdout.write(`━━━ [${index + 1}/${total}] ${item.name} · ${item.priority ?? '-'} · ${item.reviewVerdict} ━━━\n`);
  if (item.description) {
    process.stdout.write(`  ${truncate(item.description, 100)}\n`);
  }
  if (item.module) process.stdout.write(`  module   : ${item.module}\n`);
  if (item.group) process.stdout.write(`  group    : ${item.group}\n`);

  // 渲染 spec.ts 预览
  const specPath = join(process.cwd(), item.specPath);
  if (existsSync(specPath)) {
    process.stdout.write(`\n  --- spec.ts (前 ${previewLines} 行) ---\n`);
    const snippet = readFileSync(specPath, 'utf-8')
      .split('\n')
      .slice(0, previewLines)
      .map((line, i) => `${String(i + 1).padStart(3, ' ')}: ${line}`)
      .join('\n');
    process.stdout.write(snippet);
    process.stdout.write(`\n  --- end ---\n\n`);
  } else {
    process.stdout.write(`  (spec.ts 缺失)\n\n`);
  }

  process.stdout.write(`  ? 裁决结果（默认 Enter=approved，q=quit，s=skip 保持原状态）\n`);

  const verdict = await select<ReviewVerdict | 'quit' | 'skip-keep'>(
    '裁决',
    [
      ...VERDICT_OPTIONS,
      { value: 'skip-keep', description: '不写 meta，保持原状态（与 s 等价）' },
    ],
    0, // 默认 approved（第 0 项）
  );

  if (verdict === 'quit') return null;
  if (verdict === 'skip-keep') return 'skip-keep';
  return verdict as ReviewVerdict;
}

// 类型 helper：实际结构是 list() 返回的元素 + 归一化的 reviewVerdict
function toCaseItem(x: { name: string; description: string; priority?: string; module?: string; group?: string; specPath: string; reviewVerdict?: ReviewVerdict }) {
  return x;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** 裁决人回退链：$SPECMINT_REVIEWER → $USER → `git config user.name` → 'unknown' */
function defaultReviewer(): string {
  const env = process.env.SPECMINT_REVIEWER || process.env.USER;
  if (env) return env;
  try {
    const out = execSync('git config user.name', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
      timeout: 1000,
    }).trim();
    if (out) return out;
  } catch {
    // git 不可用或不在仓库内，静默回退
  }
  return 'unknown';
}
