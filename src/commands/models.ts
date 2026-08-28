/**
 * models 子命令：浏览 / 选定 / 查看当前 model
 *
 * 设计要点：
 * - 数据源是 pi-agent 的 ModelRuntime（@earendil-works/pi-coding-agent）
 * - 不维护自己的 provider/model 列表——避免和 pi-agent 分裂
 * - 子命令：list / current / select
 * - 交互式选择使用 Node 内置 readline，不引入 inquirer 等额外依赖
 *
 * 模型 ID 格式：<providerId>/<modelId>
 *   例如：anthropic/claude-sonnet-latest、openai/gpt-4o
 *
 * 写回配置：通过 fs 直接 patch .specmint/config.json 的 agent.model 字段
 * 不破坏其他字段。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { loadConfigDetailed, STORAGE_LAYOUT } from '../config.js';
import { logger } from '../utils/logger.js';
import { CliError, ExitCode } from '../utils/errors.js';
import { join } from 'node:path';

// --- 类型：与 pi-agent ModelRuntime 的对外契约 ---

interface ProviderDescriptor {
  id: string;
  /** SDK 模型 ID 形式：<providerId>/<modelId> */
  models: Array<{ id: string; name?: string; available: boolean }>;
}

interface ModelSnapshot {
  providers: ProviderDescriptor[];
  current: string | null;
}

// --- 公共入口：snapshot ---

/**
 * 拉取 pi-agent 当前可用 / 已配置的 provider+model 清单。
 *
 * - 默认只列 available=true（已认证）的 model
 * - 失败抛 CliError(IO_ERROR)
 */
export async function snapshotModels(opts: { onlyAvailable?: boolean } = {}): Promise<ModelSnapshot> {
  const runtime = await safeCreateRuntime();
  const providers: ProviderDescriptor[] = [];
  for (const p of runtime.getProviders()) {
    const allModels = runtime.getModels(p.id) ?? [];
    const models = allModels
      .filter((m) => (opts.onlyAvailable ? isAvailable(runtime, p.id, m.id) : true))
      .map((m) => ({
        id: m.id,
        name: typeof (m as { displayName?: string }).displayName === 'string'
          ? (m as { displayName?: string }).displayName
          : undefined,
        available: isAvailable(runtime, p.id, m.id),
      }));
    providers.push({ id: p.id, models });
  }
  const config = loadConfigDetailed();
  return {
    providers,
    current: config.config.agent.model ?? null,
  };
}

function safeCreateRuntime(): Promise<ModelRuntime> {
  try {
    return ModelRuntime.create();
  } catch (err) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `初始化 pi-agent ModelRuntime 失败：${(err as Error).message}`,
      hint: '请确认已通过 pi-agent 的 `/login` 配置好至少一个 provider',
    });
  }
}

function isAvailable(runtime: ModelRuntime, providerId: string, modelId: string): boolean {
  try {
    const snap = runtime.getAvailableSnapshot();
    return snap.some((m) => (m as { provider: string }).provider === providerId && m.id === modelId);
  } catch {
    return false;
  }
}

// --- 子命令：list ---

export interface ModelsListOptions {
  all?: boolean;
  json?: boolean;
}

export async function modelsListCommand(options: ModelsListOptions): Promise<void> {
  const snap = await snapshotModels({ onlyAvailable: !options.all });

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, current: snap.current, providers: snap.providers }, null, 2) + '\n');
    return;
  }

  if (snap.providers.every((p) => p.models.length === 0)) {
    logger.warn('没有可用 model。请先在 pi-agent 中登录 provider（运行 pi /login）。');
    return;
  }

  process.stdout.write(`当前配置：${snap.current ?? '(未选定，将使用 pi-agent 默认)'}\n\n`);

  for (const p of snap.providers) {
    process.stdout.write(`[${p.id}]\n`);
    for (const m of p.models) {
      const mark = m.available ? '✓' : ' ';
      const label = m.name ? `${m.name} (${m.id})` : m.id;
      process.stdout.write(`  ${mark} ${p.id}/${m.id}  ${label}\n`);
    }
    process.stdout.write('\n');
  }
}

// --- 子命令：current ---

export interface ModelsCurrentOptions {
  json?: boolean;
}

export async function modelsCurrentCommand(options: ModelsCurrentOptions): Promise<void> {
  const config = loadConfigDetailed();
  const current = config.config.agent.model ?? null;
  const sourcePath = config.configPath;

  if (options.json) {
    process.stdout.write(JSON.stringify({ ok: true, current, configPath: sourcePath }, null, 2) + '\n');
    return;
  }

  process.stdout.write(`configPath: ${sourcePath}\n`);
  process.stdout.write(`model:      ${current ?? '(未指定 → 由 pi-agent 自动选第一个可用)'}\n`);
  if (!current) {
    process.stdout.write('\n提示：运行 `specmint models select` 选定一个 model。\n');
  }
}

// --- 子命令：select ---

export interface ModelsSelectOptions {
  json?: boolean;
}

/**
 * 交互式选择 model，写回 config。
 *
 * 流程：
 * 1. 拉取 available model 清单
 * 2. 让用户选 provider
 * 3. 让用户选 model
 * 4. 写回 .specmint/config.json
 */
export async function modelsSelectCommand(options: ModelsSelectOptions): Promise<void> {
  const snap = await snapshotModels({ onlyAvailable: true });

  const availableModels = snap.providers.flatMap((p) =>
    p.models.filter((m) => m.available).map((m) => ({ providerId: p.id, model: m })),
  );

  if (availableModels.length === 0) {
    throw new CliError({
      code: ExitCode.USAGE_ERROR,
      message: '没有可用的 model。请先在 pi-agent 中登录至少一个 provider。',
      hint: '在 pi-agent REPL 中运行 /login 选择 provider 并提供 API key。',
    });
  }

  const providerChoices = snap.providers
    .filter((p) => p.models.some((m) => m.available))
    .map((p) => p.id);

  const providerId = options.json
    ? providerChoices[0]
    : await pickFromList('选择 provider', providerChoices);

  const modelChoices = snap.providers
    .find((p) => p.id === providerId)!
    .models.filter((m) => m.available)
    .map((m) => m.id);

  const modelId = options.json
    ? modelChoices[0]
    : await pickFromList(`选择 model (provider: ${providerId})`, modelChoices);

  const fullId = `${providerId}/${modelId}`;

  await writeModelToConfig(fullId);

  logger.info(`✓ 已写入 ${STORAGE_LAYOUT.configFile}：agent.model = "${fullId}"`);
}

/**
 * 把选定的 model 写回 config.json 的 agent.model 字段，保持其他字段不变。
 */
async function writeModelToConfig(modelId: string): Promise<void> {
  const configPath = join(process.cwd(), STORAGE_LAYOUT.configFile);
  if (!existsSync(configPath)) {
    throw new CliError({
      code: ExitCode.NOT_FOUND,
      message: `找不到 ${STORAGE_LAYOUT.configFile}，请先运行 specmint init`,
    });
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `解析 ${configPath} 失败：${(err as Error).message}`,
    });
  }

  const agent = (raw.agent as Record<string, unknown> | undefined) ?? {};
  agent.model = modelId;
  raw.agent = agent;

  try {
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
  } catch (err) {
    throw new CliError({
      code: ExitCode.IO_ERROR,
      message: `写入 ${configPath} 失败：${(err as Error).message}`,
    });
  }
}

/**
 * 用 readline 实现简单的单选列表（不引入 inquirer）。
 * 序号 + 回车即可；按 q 取消。
 */
async function pickFromList(title: string, items: readonly string[]): Promise<string> {
  if (items.length === 0) {
    throw new CliError({
      code: ExitCode.USAGE_ERROR,
      message: `${title}：没有可选项`,
    });
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`${title}\n`);
    items.forEach((it, i) => process.stdout.write(`  ${i + 1}) ${it}\n`));
    process.stdout.write('> ');

    const answer: string = await new Promise((resolve) => {
      rl.once('line', (line) => resolve(line.trim()));
    });

    if (answer === 'q' || answer === '') {
      throw new CliError({
        code: ExitCode.USAGE_ERROR,
        message: '已取消',
      });
    }

    const idx = parseInt(answer, 10);
    if (Number.isNaN(idx) || idx < 1 || idx > items.length) {
      throw new CliError({
        code: ExitCode.USAGE_ERROR,
        message: `无效选择：${answer}`,
      });
    }
    return items[idx - 1]!;
  } finally {
    rl.close();
  }
}