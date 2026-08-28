# auto-test

> 面向 agent 的 Playwright 页面测试 CLI 工具：自然语言生成用例、可重跑、历史可追溯。

底层基于 [Playwright](https://playwright.dev/) 与本地 [pi-coding-agent](https://github.com/badlogic/pi-mono)。0 造轮子：复用 `@playwright/test` runner / retry / trace / HTML report，通过 SDK Extensions 注入结构化的用例库工具，让 LLM 直接落盘。

---

## 特性

- **自然语言生成用例**：根据描述或结合真实页面探索生成可读性好的 `.spec.ts` 脚本
- **两种生成模式**：纯描述生成（快） / 页面探索生成（先用 Playwright 打开 URL 提取 a11y 快照，准确度更高）
- **强约束可读性**：强制语义定位器（`getByRole` / `getByLabel` / `getByTestId`），禁止易碎选择器，关键步骤中文注释
- **少样本示例库**：内置 `login-flow` / `form-submit` / `list-search` / `detail-page` 等场景示例，prompt 自动匹配，输出风格稳定
- **探索快照缓存**：相同 URL 的 a11y 快照落盘复用（默认 TTL 10 分钟），实测每次生成省 5–15s 浏览器启动
- **CLI 强制归类**：`--module` / `--group` 一键锁定用例模块与分组，避免 PI 自由发挥污染目录
- **按模块 / 分组过滤**：`list` 与 `list_cases` 支持 `--module` / `--group`，大型用例库检索更高效
- **重跑与历史**：失败用例一键重跑，每次运行落盘到 `reports/runs/<batchId>/run.json`，可追溯
- **批次号友好**：`run` 默认产物目录用 `YYYY-MM-DD_HHMMSS` 命名；加 `--label <slug>` 可拼成 `2026-08-27_150059-smoke`，一眼看出谁跑、什么时候跑
- **test-results 按批次号组织**：Playwright 的 screenshots/videos/traces 全部落到 `.auto-test/reports/runs/<batchId>/artifacts/`，不再污染项目根
- **可重入自愈**：`heal` 子命令把失败用例与日志委托给 pi-agent 自动修复
- **面向 agent 友好**：所有命令支持 `--json` 输出，结构化错误，退出码语义清晰
- **skill 一键导出**：`skill export` 生成 CodeBuddy / Claude Code 可加载的 SKILL.md

---

## 安装

```bash
# 0. 初始化项目（生成目录结构 + 默认配置；不再生成 playwright.config.ts，配置全在包内）
npx auto-test init

# 1. 安装 npm 依赖
npm install

# 2. 安装 Playwright 浏览器（至少 chromium）
#    内网/受限环境可省略这步；auto-test 会自动回退到系统 Chrome/Edge
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

# 2. 设置 baseURL（executor 透传给子进程 BASE_URL，不再断链）
#    也可以写到 .auto-test/config.json runner.baseURL，env 仍可临时覆盖
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
| `generate <description>` | 生成测试用例；支持 `--url` / `--module` / `--group` / `--priority` / `--no-explore-cache` / `--page-object` |
| `run [pattern]` | 运行用例；透传 `--browser` / `--workers` / `--retries` / `--headed` / `--ui` / `--debug` / `--grep` / `--label <slug>` |
| `rerun [--from <runId>]` | 重跑最近一次（或指定）失败用例 |
| `list [--tag <tag>] [--module <m>] [--group <g>]` | 列出用例库，支持按模块 / 分组过滤 |
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
│   ├── explore.ts        # 页面探索：a11y 快照 + CLI 约束注入
│   ├── explore-cache.ts  # 探索快照缓存（URL + storageState 指纹 + TTL）
│   ├── checkpoint.ts     # agent 运行断点（可恢复）
│   └── templates/        # 内置少样本示例库（login-flow / form-submit / list-search / detail-page）
├── store/                # 用例库 + 运行历史
├── runner/               # executor (CLI spawn) + reporter (结果落盘)
├── templates/            # spec / POM / meta 骨架
└── utils/                # logger + errors + 并发控制 + 重试 + 模板渲染
```

数据流：

```
generate  → CaseStore.save → tests/*.spec.ts + *.meta.json
run       → HistoryStore.createRun → 生成 batchId (YYYY-MM-DD_HHMMSS[-<slug>])
            → spawn playwright test 子进程（注入 AUTO_TEST_OUTPUT_DIR / AUTO_TEST_JSON_OUTPUT_FILE）
              ├─ artifacts → .auto-test/reports/runs/<batchId>/artifacts/  (screenshots/videos/traces)
              └─ results.json → .auto-test/reports/runs/<batchId>/results.json
            → reporter.onTestEnd → HistoryStore.appendResult + CaseStore.applyRunStats
            → reporter.onEnd → HistoryStore.finalizeRun
rerun     → HistoryStore.getLatestFailedTestNames → runTests(pattern)
history   → HistoryStore.listRuns
heal      → pi-agent.update_case → CaseStore.updateCode
skill     → 写入 ./skills/auto-test/SKILL.md
```

## 批次号与产物落点

`run` 命令每次执行都会生成一个**批次号**（batchId）作为该次运行的唯一目录名：

```
YYYY-MM-DD_HHMMSS[-<slug>]
```

| 形态 | 示例 | 说明 |
|------|------|------|
| 默认 | `2026-08-27_150059` | 短、自带自然排序、shell 安全 |
| 带 `--label` | `2026-08-27_150059-smoke` | 拼上 kebab-case 语义标签，便于一眼识别 |
| 冲突 | `2026-08-27_150059-smoke-2` | 同批次号已存在时自动追加 `-2` / `-3` |

每个批次号对应一个目录，里面整齐地放齐所有产物：

```
.auto-test/reports/runs/<batchId>/
├── run.json                # auto-test 结构化历史（runId / label / cases / totals / results）
├── results.json            # Playwright JSON reporter 输出
└── artifacts/              # Playwright outputDir（screenshots / videos / traces）
    └── <test-name>-.../
```

**子进程注入**：executor 在 spawn playwright CLI 时会注入两个环境变量：

- `AUTO_TEST_OUTPUT_DIR` → `.auto-test/reports/runs/<batchId>/artifacts`
- `AUTO_TEST_JSON_OUTPUT_FILE` → `.auto-test/reports/runs/<batchId>/results.json`

`playwright.config.ts` 模板读这两个 env 决定 outputDir / JSON reporter 落点。即使 env 缺失，仍会回退到 `./test-results` / `./reports/runs/.tmp/results.json`，但**强烈建议**保持 env 注入启用，让 test-results 也待在 `.auto-test/` 内。

**`--label` 校验**：kebab-case（`^[a-z][a-z0-9-]*[a-z0-9]$`），长度 1–32。合法示例：`smoke`、`p0-regression`、`nightly-batch-2`。

---

## 配置

`auto-test.config.json` 关键字段：

```json
{
  "agent": { "model": "anthropic/claude-sonnet-latest", "delegate": "sdk" },
  "explore": {
    "headless": true,
    "timeoutMs": 15000,
    "maxElements": 200,
    "cache": { "enabled": true, "ttlMs": 600000, "dir": ".auto-test/cache/explore" }
  },
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

**探索快照缓存**：相同 URL（+ storageState 指纹）的 a11y 快照会落到 `.auto-test/cache/explore/` 复用，`ttlMs` 内多次生成不会重复打开浏览器。需要强制刷新时加 `--no-explore-cache` 或直接删除目录。

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

---

## v2 升级说明（2026-08）

### 关键改动

- **目录布局**：所有 auto-test 产物（含两个配置）都在 `.auto-test/` 下，项目根零污染
- **路径不可配置**：`.auto-test/` 强制约定，不支持在 config.json 里改 root / casesDir / reportsDir
- **配置位置**：`auto-test.config.json` → `.auto-test/config.json`；`playwright.config.ts` → `.auto-test/playwright.config.ts`
- **用例优先级**：`priority` (P0|P1|P2|P3) 强制必填；generate 命令必须 `--priority P0`
- **PI 输出契约**：归一化层兜底（"高"/p0/urgent → P0）
- **用例分组**：`group/name.spec.ts` 形式（如 `auth/login-success`）
- **auth 子系统**：`.auto-test/auth/<name>.setup.ts` + `.auto-test/auth/storage/<name>.json`
- **Playwright projects**：自动拆 auth-setup + e2e（setup 空时跳过）

### 新命令

- `auto-test auth list / init / refresh / generate`
- `auto-test models list / current / select`
- `auto-test list --priority P0,P1 --auth admin`
- `auto-test run --auth admin --header "K=V" --no-auth`

### 升级步骤

1. 删除项目根的 `auto-test.config.json` 和 `playwright.config.ts`（如有）
2. 删除项目根的 `tests/` 和 `reports/`（如有）
3. `npx auto-test init`（重建 `.auto-test/` 布局）
4. `npx auto-test models select`（首次选择 LLM）
5. `npx auto-test auth init admin`（如有登录态需求）
6. `npx auto-test generate "<描述>" --priority P0`（开始生成）

---

## v2.1 增量（2026-08）

### 新增能力

- **少样本示例库**：agent 提示词内联 `login-flow` / `form-submit` / `list-search` / `detail-page` 四个场景的完整样例，自动按描述关键词匹配，输出风格更稳
- **探索快照缓存**：`src/agent/explore-cache.ts` 把 (URL + storageState) → a11y 快照落盘到 `.auto-test/cache/explore/`，TTL 默认 10 分钟；同 URL 反复生成时直接复用，省掉浏览器启动
- **CLI 强制归类**：`generate` 新增 `--module` / `--group`，直接覆盖 PI 输出，绕过归一化层，避免脏目录
- **list / list_cases 过滤**：新增 `--module` / `--group` 过滤，配合大量用例的检索更顺手
- **可恢复断点**：`src/agent/checkpoint.ts` 把每次 generate 的中间态落盘，遇到异常可恢复
- **工具层扩展**：`src/utils/concurrency.ts`（并发控制）、`src/utils/prompt.ts`（模板渲染）、`src/utils/retry.ts`（重试）下沉通用能力

### 配置增量

`.auto-test/config.json`：

```jsonc
{
  "explore": {
    "cache": {
      "enabled": true,        // 是否启用快照缓存
      "ttlMs": 600000,        // 10 分钟；过期的快照会被忽略并重建
      "dir": ".auto-test/cache/explore"  // 缓存目录
    }
  }
}
```

### CLI 增量

```bash
# 强制归类到「用户认证」模块 / auth 分组（v2.1+）
npx auto-test generate "登录成功" \
  --url http://localhost:4000/login \
  --module 用户认证 --group auth \
  --priority P0

# 强制刷新探索快照
npx auto-test generate "..." --url ... --no-explore-cache

# 按模块 / 分组检索用例（v2.1+）
npx auto-test list --module 用户认证 --group auth --json
```

### 兼容说明

- 完全向后兼容 v2：旧 `.auto-test/` 项目无需改动；首次运行会按需自动创建 `cache/` 子目录
- 关闭缓存只需 `explore.cache.enabled = false` 或运行时加 `--no-explore-cache`
- 升级前可删除 `.auto-test/cache/` 强制冷启动（不会影响用例与报告）

---

## v2.2 增量（2026-08）

### 新增能力

- **test-results 按批次号组织**：Playwright 的 `outputDir`（screenshots / videos / traces）现在指向 `.auto-test/reports/runs/<batchId>/artifacts/`，不再污染项目根
- **批次号友好**：默认 `YYYY-MM-DD_HHMMSS`（如 `2026-08-27_150059`），自带自然排序、shell 安全
- **可选 `--label <slug>`**：`auto-test run --label smoke` 拼成 `2026-08-27_150059-smoke`，一眼看出谁跑、什么时候跑
- **JSON 报告不再中转**：`results.json` 直接落到 `<batchId>/results.json`，删除旧 `.tmp/` 间接层

### 子进程 env 约定

executor 在 spawn `playwright test` 前注入：

| env | 值 |
|-----|----|
| `AUTO_TEST_OUTPUT_DIR` | `.auto-test/reports/runs/<batchId>/artifacts` |
| `AUTO_TEST_JSON_OUTPUT_FILE` | `.auto-test/reports/runs/<batchId>/results.json` |

`playwright.config.ts` 模板（`init` 生成）从这两个 env 决定 outputDir 和 JSON reporter 落点。

### batchId 冲突处理

同 batchId 已存在时自动追加 `-2` / `-3` …（最多 `-999`，再回退毫秒）。

### CLI 增量

```bash
# 加语义标签：批次号 = 2026-08-27_150059-smoke
npx auto-test run --priority P0 --label smoke

# CI 跑 nightly 批次
npx auto-test run --priority P0 --label nightly-batch-2
```

### 兼容说明

- 完全向后兼容 v2.1：旧 `.auto-test/reports/runs/<ISO>/` 目录仍可读
- 项目根遗留的 `test-results/` / `playwright-report/` 手动 `rm -rf` 清理一次即可
- `playwright.config.ts` 模板升级：手动加入 `outputDir: process.env.AUTO_TEST_OUTPUT_DIR ?? './test-results'` 与 JSON reporter 同样从 env 读取

---

## v2.3 增量（2026-08）

### 新增能力

- **包内配置接管**：`.auto-test/playwright.config.ts` 与 `.auto-test/auto-test-reporter.ts` 不再生成为用户文件，统一在 auto-test 包内 `dist/runner/playwright.config.{js,ts}` 自带；executor 通过 `import.meta.url` 定位并 `--config` 指向。彻底消灭"模板内联版 vs 包内版"双实现漂移
- **深度自定义逃生舱**：`auto-test run --config <path>` 可显式指定自定义 Playwright 配置
- **浏览器通道自动回退**：`runner.browserChannel: "auto"`（默认），检测链 chromium → 系统 Chrome → 系统 Edge。**内网/受限环境无需下载 Playwright chromium**，开箱即用
- **失败现场默认保留**：`runner.trace` 默认从 `on-first-retry` 提升为 `retain-on-failure`，heal 时 LLM 有页面现场可看；磁盘占用可控（仅失败用例产生，约 1-5 MB / 用例）
- **`BASE_URL` 透传修复**：executor 显式注入 `BASE_URL = AUTO_TEST_BASE_URL ?? ...` 给子进程（之前仅 `...process.env` 不带过去，`AUTO_TEST_BASE_URL` 等于没生效）
- **登录态按需启用**：auth-setup project 仅在检测到 `*.setup.ts` 时才挂载，根治"占位 setup 失败连坐真实用例 → did not run"与"无 setup 时跑空"两个独立 bug
- **InitResult 接口裁剪**：`init` 不再返回 `wrotePlaywrightConfig` / `wroteAutoTestReporter` / `wroteAdminSetup` 字段（不再生成）
- **env 协议收口**：所有 `AUTO_TEST_*` env 由 `src/runner/spawn-env.ts` 统一注入，run/rerun/auth refresh 三入口共用同一协议

### 配置增量

`.auto-test/config.json` `runner` 段新增字段：

```jsonc
"runner": {
  "defaultBrowser": "chromium",
  "trace": "retain-on-failure",   // 默认提升（v2.2 是 on-first-retry）
  "screenshot": "only-on-failure",
  "timeoutMs": 30000,              // 新增：单用例超时
  "browserChannel": "auto"         // 新增：auto | chromium | chrome | msedge
}
```

### 内网/受限环境

```bash
# 1. auto 模式（默认）：无需任何配置；chromium 缺失自动回退系统 Chrome/Edge
npx auto-test run

# 2. 显式固定系统 Chrome（CI 容器常用）
# .auto-test/config.json runner.browserChannel: "chrome"

# 3. 用内网镜像下载 Playwright chromium
PLAYWRIGHT_DOWNLOAD_HOST=https://<内网镜像>/ npx playwright install chromium
```

### 升级步骤（v2.2 → v2.3）

```bash
# 1. 删旧 init 产物（包内配置接管，不再生成）
rm .auto-test/playwright.config.ts .auto-test/auto-test-reporter.ts
rm .auto-test/auth/admin.setup.ts   # 占位 setup，避免连坐

# 2. 重新 init（幂等；检测到旧文件会给出"可删除"提示）
npx auto-test init

# 3. config.json runner 段新增 timeoutMs / browserChannel；trace 默认变 retain-on-failure
#    如果你以前设过 trace=on-first-retry，手动改回
```

### CLI 增量

```bash
# 显式指定自定义 Playwright 配置（高级选项）
npx auto-test run --config ./my-playwright.config.ts

# 强制使用系统 Chrome（跳过 auto 检测）
# 在 config.json 里设 runner.browserChannel: "chrome"
```
