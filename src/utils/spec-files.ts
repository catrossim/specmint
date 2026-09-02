/**
 * spec 文件收集工具（供 case-store / lint / adopt 共用）
 *
 * 之所以抽出来：`.specmint/cases/` 下哪些文件算"用例"必须只有一个判定口径。
 * 若 lint / adopt 各写一份收集逻辑，迟早出现「lint 扫得到但 run 跑不到」的漂移。
 *
 * 统一约定：
 * - 文件名以 `.spec.ts` 结尾
 * - 跳过 `pages/`（Page Object 不是用例）、`node_modules/`、以 `.` 开头的目录
 * - 目录名比较大小写不敏感（NTFS 默认大小写不敏感，但用户目录可能是 Pages）
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative as pathRelative, resolve } from 'node:path';

/**
 * 递归收集目录树下所有 `.spec.ts` 文件的绝对路径。
 * 结果按路径升序，保证输出稳定（快照友好）。
 */
export function collectSpecFiles(rootDir: string): string[] {
  const out: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const lower = entry.toLowerCase();
        if (lower === 'pages' || lower === 'node_modules' || entry.startsWith('.')) continue;
        walk(full);
      } else if (stat.isFile() && entry.endsWith('.spec.ts')) {
        out.push(full);
      }
    }
  }

  walk(rootDir);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/** glob → 正则（仅支持 `*` / `**` / `?`，不引第三方 glob 依赖） */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      const isDoubleStar = glob[i + 1] === '*';
      if (isDoubleStar) {
        i++;
        // `**/` 匹配零到多层目录，`**` 结尾匹配任意字符
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:[^/]+/)*';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export interface ResolveSpecTargetsOptions {
  /** 用例库根目录（绝对路径） */
  casesDir: string;
  /** 工作根，用于把绝对路径转成正斜杠相对路径 */
  cwd: string;
}

/**
 * 把用户输入（文件路径 / 目录 / glob）解析为具体的 `.spec.ts` 绝对路径列表。
 *
 * 解析优先级：
 * 1. 未传 target → 扫描整个 casesDir
 * 2. 路径存在且是文件 → 单文件（不要求必须以 .spec.ts 结尾，但会校验）
 * 3. 路径存在且是目录 → 递归该目录
 * 4. 其余（含 `*`、`**`）→ 当作 glob，对 casesDir 下所有 spec 的「正斜杠相对路径」做匹配
 *
 * 路径归一化：统一正斜杠 + 相对 casesDir，与 case-store 的 name 推导口径一致。
 */
export function resolveSpecTargets(
  target: string | undefined,
  options: ResolveSpecTargetsOptions,
): string[] {
  const { casesDir, cwd } = options;

  if (!target || target.trim() === '') {
    return collectSpecFiles(casesDir);
  }

  const raw = target.replace(/\\/g, '/');
  const abs = resolve(cwd, raw);

  if (existsSync(abs)) {
    // 单个文件
    if (statSync(abs).isFile()) return [abs];
    // 目录
    return collectSpecFiles(abs);
  }

  // glob 匹配：先剥掉可能存在的 casesDir 前缀，方便用户写 `.specmint/cases/**/*.spec.ts`
  const casesRel = pathRelative(cwd, casesDir).replace(/\\/g, '/');
  let normalized = raw;
  if (raw.startsWith('./')) normalized = raw.slice(2);
  if (casesRel && normalized.startsWith(casesRel + '/')) {
    normalized = normalized.slice(casesRel.length + 1);
  }

  const rx = globToRegExp(normalized);
  return collectSpecFiles(casesDir).filter((file) => {
    const rel = pathRelative(casesDir, file).replace(/\\/g, '/');
    return rx.test(rel) || rx.test(pathRelative(cwd, file).replace(/\\/g, '/'));
  });
}

/**
 * 由 spec 文件的绝对路径推导用例内部名（含 group 前缀，kebab-case）。
 * 与 case-store 的 name 推导口径一致：`<casesDir>/auth/login-success.spec.ts` → `auth/login-success`
 */
export function caseNameFromSpecPath(casesDir: string, specFile: string): string {
  const rel = pathRelative(casesDir, specFile).replace(/\\/g, '/');
  return rel.replace(/\.spec\.ts$/, '');
}
