import { createInterface } from 'node:readline';

/**
 * 探测：当前是否处于交互式 TTY。
 * 用于在主流程里提前决定走交互还是自动分支。
 */
export function canPromptInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/**
 * 一次确认：返回 true / false。空输入按 defaultValue 走。
 * 非 TTY 直接返回 defaultValue。
 */
export async function confirm(question: string, defaultValue: boolean = false): Promise<boolean> {
  if (!canPromptInteractive()) return defaultValue;
  const hint = defaultValue ? '[Y/n]' : '[y/N]';
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`? ${question} ${hint}: `, (answer) => {
      rl.close();
      const raw = answer.trim().toLowerCase();
      if (raw === '') return resolve(defaultValue);
      if (raw === 'y' || raw === 'yes') return resolve(true);
      if (raw === 'n' || raw === 'no') return resolve(false);
      resolve(defaultValue);
    });
  });
}

/**
 * 自由文本输入。空输入返回空串。空校验由调用方决定。
 * 非 TTY 抛错（强制要求交互的场景才会走到这里）。
 */
export async function askText(question: string, placeholder?: string): Promise<string> {
  if (!canPromptInteractive()) {
    throw new Error('askText: 非交互式终端无法读取文本');
  }
  const ph = placeholder ? ` (默认: ${placeholder})` : '';
  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`? ${question}${ph}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * 多选菜单：返回选中的 values 数组（保持输入顺序）。
 * 输入格式：逗号 / 空格分隔的索引，例如 "1,3" 或 "1 3"；"* "表示全选；空输入返回 defaultIndices。
 * 非 TTY 直接返回 defaultIndices 对应的 values。
 */
export async function multiSelect<T extends string>(
  question: string,
  options: ReadonlyArray<{ value: T; description?: string }>,
  defaultIndices: ReadonlyArray<number> = [],
): Promise<T[]> {
  const fallback = defaultIndices.map((i) => options[i]?.value).filter((v): v is T => !!v);
  if (!canPromptInteractive()) return fallback;
  if (options.length === 0) return [];

  process.stdout.write(`\n${question}\n`);
  options.forEach((opt, i) => {
    const num = String(i + 1);
    const desc = opt.description ? `  ${opt.description}` : '';
    const mark = defaultIndices.includes(i) ? ' (默认)' : '';
    process.stdout.write(`  ${num}) ${opt.value}${desc}${mark}\n`);
  });
  const hint = `多选用逗号分隔 (例: 1,3)；* 全选；空 = 默认`;

  return new Promise<T[]>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`? 选择 ${hint}: `, (answer) => {
      rl.close();
      const raw = answer.trim();
      if (raw === '') return resolve(fallback);
      if (raw === '*') return resolve(options.map((o) => o.value));
      const tokens = raw.split(/[\s,]+/).filter(Boolean);
      const indices = new Set<number>();
      for (const tok of tokens) {
        const n = Number.parseInt(tok, 10);
        if (!Number.isNaN(n) && n >= 1 && n <= options.length) indices.add(n - 1);
      }
      if (indices.size === 0) return resolve(fallback);
      const picked: T[] = [];
      indices.forEach((i) => {
        const opt = options[i];
        if (opt) picked.push(opt.value);
      });
      resolve(picked);
    });
  });
}

/**
 * 单选菜单：用户输入数字、首字母、完整 value 都可命中。
 *
 * 与 confirm / askText 一致的兜底：非 TTY 直接返回 defaultIndex 对应的 value。
 */
export interface SelectOption<T extends string> {
  value: T;
  /** 候选描述，单行文本 */
  description?: string;
  /** 首字母用于快捷输入（默认取 value[0]） */
  shortcut?: string;
}

export async function select<T extends string>(
  question: string,
  options: ReadonlyArray<SelectOption<T>>,
  defaultIndex: number = 0,
): Promise<T> {
  // 空选项保护前置：先 throw，避免后续 options[i] 引发 TS2532
  if (options.length === 0) {
    throw new Error('select() 至少需要一个选项');
  }
  // safeIdx 已在 [0, options.length-1] 范围内，可安全非空断言
  const safeIdx = Math.max(0, Math.min(defaultIndex, options.length - 1));
  const fallback = options[safeIdx]!.value;
  if (!canPromptInteractive()) return fallback;

  process.stdout.write(`\n${question}\n`);
  options.forEach((opt, i) => {
    const num = String(i + 1);
    const desc = opt.description ? `  ${opt.description}` : '';
    const isDefault = i === defaultIndex ? ' (默认)' : '';
    process.stdout.write(`  ${num}) ${opt.value}${desc}${isDefault}\n`);
  });
  const hint = `[1-${options.length} / 首字母 / Enter 取默认]`;

  return new Promise<T>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`? 选择 ${hint}: `, (answer) => {
      rl.close();
      const raw = answer.trim().toLowerCase();
      if (raw === '') return resolve(fallback);

      // 数字命中
      const asNum = Number.parseInt(raw, 10);
      if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= options.length) {
        const opt = options[asNum - 1];
        if (opt) return resolve(opt.value);
      }
      // 完整 value 命中
      const byValue = options.find((o) => o.value.toLowerCase() === raw);
      if (byValue) return resolve(byValue.value);
      // 首字母命中（取首个匹配）；value 为空串时用 '' 兜底，避免 TS2532
      const byShortcut = options.find((o) => (o.shortcut ?? o.value[0] ?? '').toLowerCase() === raw);
      if (byShortcut) return resolve(byShortcut.value);
      // 兜底
      resolve(fallback);
    });
  });
}
