# auto-test

> 面向 agent 的 Playwright 页面测试 CLI 工具：自然语言生成用例、可重跑、历史可追溯。

底层基于 [Playwright](https://playwright.dev/) 与本地 [pi-coding-agent](https://github.com/badlogic/pi-mono)。0 造轮子：复用 `@playwright/test` runner / retry / trace / HTML report，通过 SDK Extensions 注入结构化的用例库工具，让 LLM 直接落盘。

---

## 特性

- **自然语言生成用例**：根据描述或结合真实页面探索生成可读性好的 `.spec.ts` 脚本
- **两种生成模式**：纯描述生成（快） / 页面探索生成（先用 Playwright 打开 URL 提取 a11y 快照，准确度更高）
- **强约束可读性**：强制语义定位器（`getByRole` / `getByLabel` / `getByTestId`），禁止易碎选择器，关键步骤中文注释
- **重跑与历史**：失败用例一键重跑，每次运行落盘到 `reports/runs/<ts>/run.json`，可追溯
- **面向 agent 友好**：所有命令支持 `--json` 输出，结构化错误，退出码语义清晰
- **可重入自愈**：`heal` 子命令把失败用例与日志委托给 pi-agent 自动修复
- **skill 一键导出**：`skill export` 生成 CodeBuddy / Claude Code 可加载的 SKILL.md

---

## 安装

```bash
# 0. 初始化项目（生成目录结构 + 默认配置）
npx auto-test init

# 1. 安装 npm 依赖
npm install

# 2. 安装 Playwright 浏览器（至少 chromium）
npx playwright install chromium
```

需要 Node.js 20+。

**Playwright 版本与浏览器 revision 的对应关系（重要）**：本项目锁定了 `@playwright/test@1.58.0` / `playwright@1.58.0`，对应 `chromium-1208` 与 `chromium_headless_shell-1208`。如果你本地已经装过 Playwright 浏览器但版本号不一致（如 1.50 / 1.55 / 1.59 / 1.62 等），需要按对应版本重新安装，否则 `chromium.launch()` 会报"Executable doesn't exist"。

版本对应速查：
| Playwright | chromium | headless_shell |
|---|---|---|
| 1.57.x | 1200 | 1200 |
| **1.58.x（项目锁定）** | **1208** | **1208** |
| 1.59.x | 1217 | 1217 |
| 1.60.x | 1223 | 1223 |
| 1.62.x | 1234 | 1234 |

如果你想升级 Playwright，记得先 `npx playwright install chromium` 让浏览器跟上。

浏览器缓存路径：
- macOS：`~/Library/Caches/ms-playwright/`
- Linux：`~/.cache/ms-playwright/`
- Windows：`%LOCALAPPDATA%\ms-playwright\`

---

## 快速开始（5 分钟跑通全链路）

```bash
# 1. 启动示例应用（另开终端）
node examples/serve.mjs
# → http://localhost:4000

# 2. 设置 baseURL
export AUTO_TEST_BASE_URL=http://localhost:4000

# 3. 用 generate 生成用例（探索模式）
npx auto-test generate \
  "登录：admin/admin123 登录成功跳转 dashboard，错误密码显示用户名或密码错误" \
  --url http://localhost:4000/login-demo.html \
  --name login-e2e

# 4. 运行
npx auto-test run login-e2e

# 5. 查看历史 / 重跑失败 / 修复
npx auto-test history
npx auto-test rerun
npx auto-test heal login-e2e
```

完整端到端步骤见 [`examples/e2e-verify.md`](./examples/e2e-verify.md)。

---

## 子命令一览

详细使用手册：[docs/USAGE.md](./docs/USAGE.md)

| 命令 | 用途 |
|---|---|
| `init` | 初始化项目结构与默认配置 |
| `generate <description>` | 生成测试用例；可选 `--url` 启用页面探索模式；可选 `--page-object` 同步生成 POM |
| `run [pattern]` | 运行用例；透传 `--browser` / `--workers` / `--retries` / `--headed` / `--ui` / `--debug` / `--grep` |
| `rerun [--from <runId>]` | 重跑最近一次（或指定）失败用例 |
| `list [--tag <tag>]` | 列出用例库 |
| `show <name>` | 查看用例详情（含 spec 与 POM 代码） |
| `delete <name> [--yes]` | 删除用例 |
| `history [--limit N] [--case <name>]` | 查看运行历史 |
| `heal <name> [--from <runId>]` | 自动修复失败用例 |
| `skill export [--target codebuddy\|claude-code]` | 导出 agent skill 定义到 `./skills/auto-test/SKILL.md` |

所有子命令支持 `--json` 输出。

---

## Agent 调用样例

### 全局约定

- 所有子命令支持 `--json`，错误统一为 `{ ok: false, error: { code, message, hint } }`
- 退出码语义见下文"输出契约"
- 推荐先调用 `auto-test skill export` 把 SKILL.md 加载到 agent，让 agent 自动学会调用方式

### 推荐流程

```bash
# 1. 生成用例（探索模式）
auto-test generate "登录：admin/admin123 登录成功跳转 dashboard" \
  --url https://example.com/login \
  --name login-success \
  --json

# 解析返回的 savedCase.specPath / metaPath，决定下一步

# 2. 运行
auto-test run login-success --json

# 3. 如果失败，查看历史拿 runId
auto-test history --json

# 4. 重跑
auto-test rerun --json

# 5. 自愈
auto-test heal login-success --json
```

### 退出码（process.exitCode）

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 通用错误 |
| 2 | 参数错误（USAGE） |
| 3 | 子命令未实现 |
| 4 | 资源不存在 |
| 5 | 重复创建 |
| 6 | agent 调用失败 |
| 7 | 测试失败 |
| 8 | IO 错误 |

---

## 输出契约（--json）

### generate

```json
{
  "ok": true,
  "mode": "explore-assisted",
  "description": "...",
  "durationMs": 4321,
  "toolCalls": [{ "name": "save_case", "input": { "name": "login-success", ... } }],
  "savedCase": {
    "name": "login-success",
    "specPath": "/abs/path/tests/login-success.spec.ts",
    "metaPath": "/abs/path/tests/login-success.meta.json",
    "pageObjectPath": null
  },
  "content": "LLM 输出文本..."
}
```

### run

```json
{
  "ok": true,
  "runId": "2026-08-27T10-30-00-000Z",
  "exitCode": 0,
  "status": "passed",
  "durationMs": 12345,
  "command": "npx playwright test tests/login-success.spec.ts",
  "startedAt": "2026-08-27T10:30:00.000Z"
}
```

### history

```json
{
  "ok": true,
  "count": 3,
  "items": [
    {
      "runId": "...",
      "startedAt": "...",
      "finishedAt": "...",
      "status": "passed",
      "totals": { "passed": 3, "failed": 0, "skipped": 0, "timedOut": 0, "interrupted": 0, "durationMs": 4321 },
      "failedTests": []
    }
  ]
}
```

### list

```json
{
  "ok": true,
  "count": 2,
  "items": [
    {
      "name": "login-success",
      "description": "...",
      "tags": ["smoke"],
      "status": "passed",
      "lastRunAt": "...",
      "specPath": "tests/login-success.spec.ts",
      "metaPath": "tests/login-success.meta.json",
      "pageObjectFile": null
    }
  ]
}
```

---

## 架构

```
src/
├── cli.ts                # commander 入口
├── config.ts             # auto-test.config.json 加载
├── commands/             # 各子命令实现
├── agent/                # pi-agent SDK 集成 + Extensions + prompt + 页面探索
├── store/                # 用例库 + 运行历史
├── runner/               # executor (CLI spawn) + reporter (结果落盘)
├── templates/            # spec / POM / meta 骨架
└── utils/                # logger + errors
```

数据流：

```
generate  → CaseStore.save → tests/*.spec.ts + *.meta.json
run       → spawn playwright test 子进程
            → reporter.onTestEnd → HistoryStore.appendResult + CaseStore.applyRunStats
            → reporter.onEnd → HistoryStore.finalizeRun
rerun     → HistoryStore.getLatestFailedTestNames → runTests(pattern)
history   → HistoryStore.listRuns
heal      → pi-agent.update_case → CaseStore.updateCode
skill     → 写入 ./skills/auto-test/SKILL.md
```

---

## 配置

`auto-test.config.json` 关键字段：

```json
{
  "agent": { "model": "anthropic/claude-sonnet-latest", "delegate": "sdk" },
  "explore": { "headless": true, "timeoutMs": 15000, "maxElements": 200 },
  "generation": {
    "selectorPolicy": {
      "prefer": ["getByRole", "getByLabel", "getByPlaceholder", "getByTestId", "getByText"],
      "avoid": ["nth-child", "nth-of-type", "complex-css", "xpath"]
    }
  },
  "storage": { "casesDir": "./tests", "reportsDir": "./reports" }
}
```

修改后立即生效，无需重启。

---

## 开发

```bash
# 开发态执行（无需编译）
npx tsx src/cli.ts <subcommand>

# 编译为 dist/
npm run build

# 跑单元 typecheck
npm run typecheck
```

---

## License

MIT