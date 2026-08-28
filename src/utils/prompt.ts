/**
 * 极简 CLI 交互工具
 *
 * 为什么不用 @inquirer/prompts：
 * - 体积偏大（~50KB），对一个零依赖工具是负担
 * - 我们只需要 2 个动作：单选确认 / 文本输入
 * - readline 是 node 内置，零依赖
 *
 * 行为约定：
 * - 非 TTY（CI / pipe / redirect）时返回默认值，不阻塞
 * - 环境变量 `SPECMINT_NO_INTERACTIVE=1` 强制跳过
 * - EOF（Ctrl-D / Ctrl-C）视作"使用默认值"
 */
import { createInterface } from 'node:readline';

function isInteractive(): boolean {
  if (process.env.SPECMINT_NO_INTERACTIVE === '1') return false;
  if (!process.stdin.isTTY) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

/**
 * 单选确认：返回 true / false。
 * 用户输入 y/yes/回车 → true；n/no/Ctrl-C → false。
 */
export async function confirm(
  question: string,
  defaultValue: boolean = true,
): Promise<boolean> {
  if (!isInteractive()) return defaultValue;
  const hint = defaultValue ? '[Y/n]' : '[y/N]';
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const onClose = () => resolve(defaultValue);
    rl.question(`${question} ${hint}: `, (answer) => {
      rl.close();
      const v = answer.trim().toLowerCase();
      if (v === '') return resolve(defaultValue);
      if (v === 'y' || v === 'yes') return resolve(true);
      if (v === 'n' || v === 'no') return resolve(false);
      resolve(defaultValue); // 兜底：无效输入按默认值
      // onClose 在这里永远不会被调用（rl 已被 close），但保留以防 race
      void onClose;
    });
  });
}

/**
 * 文本输入：返回用户输入（已 trim），空输入走 defaultValue。
 * 用户输入空字符串 / Ctrl-C → 返回 defaultValue。
 */
export async function askText(
  question: string,
  defaultValue: string = '',
): Promise<string> {
  if (!isInteractive()) return defaultValue;
  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const hint = defaultValue ? `[${defaultValue}]` : '';
    rl.question(`${question} ${hint}: `, (answer) => {
      rl.close();
      const v = answer.trim();
      resolve(v === '' ? defaultValue : v);
    });
  });
}

/**
 * 探测：当前是否处于交互式 TTY。
 * 用于在主流程里提前决定走交互还是自动分支。
 */
export function canPromptInteractive(): boolean {
  return isInteractive();
}