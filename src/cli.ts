#!/usr/bin/env node
/**
 * auto-test CLI 入口
 *
 * 所有子命令已接入实际实现：
 * - init: 脚手架
 * - generate: 描述/探索 → pi-agent → save_case
 * - run: 透传参数 → executor → Playwright CLI
 * - rerun: 历史中失败用例 → runTests
 * - list / show / delete: 用例库 CRUD
 * - history: 运行历史查询
 * - heal: 失败用例 → pi-agent → update_case
 * - skill export: 导出 agent skill 定义
 */
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { generateCommand } from './commands/generate.js';
import { runCommand } from './commands/run.js';
import { rerunCommand } from './commands/rerun.js';
import { listCommand } from './commands/list.js';
import { showCommand } from './commands/show.js';
import { deleteCommand } from './commands/delete.js';
import { historyCommand } from './commands/history.js';
import { healCommand } from './commands/heal.js';
import { skillExportCommand } from './commands/skill-export.js';
import {
  modelsListCommand,
  modelsCurrentCommand,
  modelsSelectCommand,
} from './commands/models.js';
import {
  authListCommand,
  authInitCommand,
  authRefreshCommand,
  authGenerateCommand,
} from './commands/auth.js';
import { CliError, ExitCode } from './utils/errors.js';
import { logger } from './utils/logger.js';
import { PRIORITIES, type Priority } from './store/types.js';

const program = new Command();

program
  .name('auto-test')
  .description('面向 agent 的 Playwright 页面测试 CLI 工具')
  .version('0.1.0')
  .option('--json', '全局 JSON 输出模式')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts<{ json?: boolean }>();
    if (opts.json || process.env.AUTO_TEST_JSON === '1') {
      logger.setJsonMode(true);
    }
  });

// --- init ---
program
  .command('init')
  .description('初始化项目结构与默认配置')
  .option('-f, --force', '覆盖已存在的配置文件')
  .option('--json', '输出 JSON 格式')
  .action(initCommand);

// --- generate ---
program
  .command('generate <description>')
  .description('根据描述（或页面探索）生成测试用例')
  .option('-u, --url <url>', '目标 URL，启用页面探索模式')
  .option('-n, --name <name>', '用例名（kebab-case）')
  .option('-p, --priority <priority>', '用例优先级（必填）：P0|P1|P2|P3', (v) => {
    const up = String(v).trim().toUpperCase();
    if (!(PRIORITIES as readonly string[]).includes(up)) {
      throw new Error(`--priority 必须是 ${PRIORITIES.join('|')} 之一，当前 "${v}"`);
    }
    return up as Priority;
  })
  .option('--model <model>', '本次生成使用的 model（覆盖 config.agent.model），格式 provider/id')
  .option('--page-object', '同步生成 Page Object 文件')
  .option('--tag <tag>', '附加标签，可多次传入', (v, prev: string[]) => prev.concat(v), [] as string[])
  .option('--json', '输出 JSON 格式')
  .action(async (description: string, options: Parameters<typeof generateCommand>[1]) => {
  await generateCommand(description, options);
});

// --- run ---
program
  .command('run [pattern]')
  .description('运行测试用例')
  .option('--browser <browser>', '指定浏览器：chromium|firefox|webkit')
  .option('--headed', '有头模式')
  .option('--ui', '使用 Playwright UI 模式')
  .option('--debug', '调试模式')
  .option('--workers <n>', '并行 worker 数', (v) => parseInt(v, 10))
  .option('--retries <n>', '重试次数', (v) => parseInt(v, 10))
  .option('--grep <pattern>', '只运行匹配标题的用例')
  .option('--priority <priority>', '按优先级过滤：P0|P1|P2|P3，可逗号分隔', (v) => {
    const list = String(v).split(',').map((s) => s.trim().toUpperCase());
    for (const p of list) {
      if (!(PRIORITIES as readonly string[]).includes(p)) {
        throw new Error(`--priority 必须是 ${PRIORITIES.join('|')} 之一，当前 "${p}"`);
      }
    }
    return list as Priority[];
  })
  .option('--header <kv>', '注入 HTTP header，K=V 形式，可多次', (v, prev: string[]) => prev.concat(v), [] as string[])
  .option('--storage-state <path>', '覆盖 config.auth.storageState（运行指定 storageState 文件）')
  .option('--no-auth', '跳过 storageState（公开页测试场景）')
  .option('--auth <name>', '按 auth 角色过滤用例（meta.auth === name）')
  .option('--json', '输出 JSON 格式')
  .action(runCommand);

// --- rerun ---
program
  .command('rerun')
  .description('重跑最近一次失败用例')
  .option('--from <runId>', '指定运行 ID（默认最近一次）')
  .option('--json', '输出 JSON 格式')
  .action(rerunCommand);

// --- list ---
program
  .command('list')
  .alias('ls')
  .description('列出所有用例')
  .option('--tag <tag>', '按 tag 过滤')
  .option('--priority <priority>', '按优先级过滤：P0|P1|P2|P3，可逗号分隔', (v) => {
    const list = String(v).split(',').map((s) => s.trim().toUpperCase());
    for (const p of list) {
      if (!(PRIORITIES as readonly string[]).includes(p)) {
        throw new Error(`--priority 必须是 ${PRIORITIES.join('|')} 之一，当前 "${p}"`);
      }
    }
    return list as Priority[];
  })
  .option('--auth <name>', '按 auth 角色过滤')
  .option('--json', '输出 JSON 格式')
  .action(listCommand);

// --- show ---
program
  .command('show <name>')
  .description('查看用例详情')
  .option('--json', '输出 JSON 格式')
  .action(showCommand);

// --- delete ---
program
  .command('delete <name>')
  .alias('rm')
  .description('删除用例')
  .option('--yes', '跳过确认')
  .option('--json', '输出 JSON 格式')
  .action(deleteCommand);

// --- history ---
program
  .command('history')
  .description('查看运行历史')
  .option('--limit <n>', '最近 N 次', '10')
  .option('--case <name>', '只显示指定用例的历史')
  .option('--json', '输出 JSON 格式')
  .action(historyCommand);

// --- heal ---
program
  .command('heal <name>')
  .description('自动修复失败用例')
  .option('--from <runId>', '指定失败来源的运行 ID（默认最近一次）')
  .option('--json', '输出 JSON 格式')
  .action(async (caseName: string, options: Parameters<typeof healCommand>[1]) => {
  await healCommand(caseName, options);
});

// --- skill ---
const skillCmd = program.command('skill').description('管理 agent skill 定义');
skillCmd
  .command('export')
  .description('在 ./skills/auto-test/ 生成 agent 可加载的 skill 文件')
  .option('--target <target>', '目标 agent：codebuddy | claude-code', 'codebuddy')
  .option('--install', '一键安装到 IDE skill 加载目录（codebuddy: .codebuddy/skills/）')
  .option('--json', '输出 JSON 格式')
  .action(async (options: Parameters<typeof skillExportCommand>[0]) => {
  await skillExportCommand(options);
});

// --- models ---
// 数据源是 pi-agent ModelRuntime（@earendil-works/pi-coding-agent），
// auto-test 不维护私有 model 列表。
const modelsCmd = program
  .command('models')
  .description('管理 agent model（数据源：pi-agent）');
modelsCmd
  .command('list')
  .description('列出 pi-agent 支持的 provider/model')
  .option('--all', '列出所有 model（包括未登录 provider）')
  .option('--json', '输出 JSON 格式')
  .action(modelsListCommand);
modelsCmd
  .command('current')
  .description('查看当前选定的 model')
  .option('--json', '输出 JSON 格式')
  .action(modelsCurrentCommand);
modelsCmd
  .command('select')
  .description('交互式选择 model 并写入 config.json')
  .option('--json', '输出 JSON 格式')
  .action(modelsSelectCommand);

// --- auth ---
// 目录约定：.auto-test/auth/<name>.setup.ts + .auto-test/auth/storage/<name>.json
const authCmd = program
  .command('auth')
  .description('管理 auth 角色（setup 文件 + storageState）');
authCmd
  .command('list')
  .description('列出所有 *.setup.ts')
  .option('--json', '输出 JSON 格式')
  .action(authListCommand);
authCmd
  .command('init <name>')
  .description('生成 setup 文件模板（手写登录步骤）')
  .option('--json', '输出 JSON 格式')
  .action(authInitCommand);
authCmd
  .command('refresh <name>')
  .description('单独跑 setup 文件，刷新 storageState')
  .option('--json', '输出 JSON 格式')
  .action(authRefreshCommand);
authCmd
  .command('generate <description>')
  .description('自然语言描述生成 setup 文件（PI 辅助）')
  .option('-n, --name <name>', 'auth name（kebab-case）')
  .option('-u, --url <url>', '目标 URL（启用探索）')
  .option('--json', '输出 JSON 格式')
  .action(authGenerateCommand);

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CliError) {
    if (process.env.AUTO_TEST_JSON === '1') {
      process.stdout.write(JSON.stringify({ ok: false, error: err.toJSON() }) + '\n');
    } else {
      logger.error(err.message);
      if (err.hint) logger.warn(`提示: ${err.hint}`);
    }
    process.exit(err.code);
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error(message);
  process.exit(ExitCode.GENERIC_ERROR);
});