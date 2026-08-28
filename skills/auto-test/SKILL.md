---
name: auto-test
description: |
  Playwright 页面测试 CLI 工具。当用户需要测试 Web 页面、生成/重跑 Playwright
  用例、查看测试历史、自动修复失败用例、管理登录态时调用。底层 pi-coding-agent + Playwright。
triggers:
  - 测试页面
  - 生成 Playwright 用例
  - 自动化测试
  - 重跑失败测试
  - 修复测试用例
  - 管理登录态
  - 配置 LLM provider
  - web 测试
---

面向 agent 的 Playwright 页面测试 CLI：自然语言生成用例、可重跑、历史可追溯、登录态管理。

**项目布局**：所有产物（含两个配置）在 `.auto-test/` 下，项目根零污染。**不可改路径**。

## 前置依赖校验（先检查再安装）

**核心原则**：执行任何 `npm install` 或 `npx playwright install` 之前，**必须先校验当前环境是否已经满足**。已满足时直接跳过安装，不要重复下载。

### Playwright npm 包校验

```bash
# 已安装：打印版本号（如 1.49.0）；未安装：command not found / 报错
npx playwright --version

# 等价的 require 方式（更稳定，不依赖 PATH）
node -e "require.resolve('playwright')" 2>/dev/null && echo "playwright: OK" || echo "playwright: MISSING"
```

### Chromium 浏览器校验

v2.3+ `runner.browserChannel: "auto"`（默认）会自动检测链：Playwright chromium → 系统 Chrome → 系统 Edge。**内网/受限环境无需任何额外配置**——auto 模式会回退到已安装的系统浏览器。

Playwright 把浏览器下载到独立的缓存目录，不需要每个项目都装一遍：

```bash
# macOS / Linux：列出已下载的浏览器版本目录
ls ~/.cache/ms-playwright/ 2>/dev/null | grep -E '^chromium-[0-9]+$' && echo "chromium: OK" || echo "chromium: MISSING"

# Windows PowerShell：
# Get-ChildItem "$env:LOCALAPPDATA\ms-playwright\" -Directory |
#   Where-Object { $_.Name -like "chromium-*" } | Select-Object -ExpandProperty Name
```

### 决策表

| 校验结果 | 处理动作 |
|---------|---------|
| `playwright: OK` **且** `chromium: OK` | 直接进入 `auto-test init` / `generate` / `run`，**跳过安装** |
| `playwright: MISSING` | `npm install`（项目根）补齐 npm 依赖 |
| `chromium: MISSING` 但 playwright 在 | v2.3+ 直接进入 `auto-test init`；auto 模式会回退系统 Chrome/Edge；如想下载则 `npx playwright install chromium` |
| 都缺失 | 先 `npm install`；auto 模式仍可继续；如想下载再 `npx playwright install chromium`，或装系统 Chrome/Edge |

> **绝对不要**在未校验前就盲目执行 `npm install` 或 `npx playwright install chromium`——v2.3+ 这两个命令对 auto 模式已非必需；只有用户明确想要 Playwright 自带 chromium 时才需要。

## 子命令

### 项目初始化

- `init` — 创建 `.auto-test/{cases,auth,reports,cache}` 目录结构 + 写入 `config.json`；v2.3+ **不再生成** `.auto-test/playwright.config.ts` 与 `.auto-test/auto-test-reporter.ts`（由包内配置 `dist/runner/playwright.config.{js,ts}` 接管）

### 模型选择（数据源：pi-agent）

- `models list [--all] [--json]` — 列出 pi-agent 支持的 LLM provider / model
- `models current [--json]` — 查看当前选定的 model（来自 `.auto-test/config.json` 的 `agent.model`）
- `models select [--json]` — 交互式选择 model 并写回 config

### 用例库

- `generate <description> -p <priority> [--url] [--page-object] [--model] [--tag] [--name] [--module <m>] [--group <g>] [--no-explore-cache]` — **必传** `--priority` (P0|P1|P2|P3)；`--module` / `--group` 强制覆盖 PI 推断；`--no-explore-cache` 强制刷新探索快照
- `list [--tag] [--priority P0,P1] [--auth] [--module <m>] [--group <g>] [--json]` — 表格输出含 PRI / AUTH / MODULE 列
- `show <name>` — 详情（含 priority / group / module / linkedTickets / auth / tags）
- `delete <name>` — 删除用例（spec + meta + POM）

### 登录态（auth 子系统）

- `auth init <name>` — 生成 `.auto-test/auth/<name>.setup.ts` 模板（手写登录步骤）
- `auth generate <description> --name <name> [--url]` — PI 生成 setup 文件
- `auth refresh <name>` — 重跑 setup 生成 storageState（写到 `.auto-test/auth/storage/<name>.json`）
- `auth list` — 列所有 setup + storageState 状态

### 运行

- `run [pattern] [--browser] [--headed] [--workers N] [--grep] [--priority] [--auth <name>] [--header "K=V"] [--storage-state <path>] [--no-auth] [--ui] [--debug] [--label <slug>] [--json]`
- `rerun [--from <runId>]` — 重跑最近一次失败用例
- `history [--limit N] [--case <name>]` — 运行历史
- `heal <name> [--from <runId>]` — PI 自愈失败用例

### Skill 管理

- `skill export [--target codebuddy|claude-code]` — 导出本 skill 定义到目标 agent

## 调用样例

> **调用前的硬性步骤**：执行 `auto-test` 任何子命令前，**先按上文"前置依赖校验"section 跑一遍校验**。校验通过时直接进入下方流程，不要重复执行 `npm install` 或 `npx playwright install chromium`。

```bash
# 0. 前置依赖校验（仅在未通过时执行对应安装命令；已通过则跳过）
npx playwright --version && \
ls ~/.cache/ms-playwright/ 2>/dev/null | grep -qE '^chromium-[0-9]+$' || \
  { echo "依赖缺失，按上文决策表补装"; npm install && npx playwright install chromium; }

# 1. 初始化项目
auto-test init

# 2. 选 LLM（首次必跑）
auto-test models select

# 3. 生成用例（必传 --priority）
auto-test generate "登录：用户名密码登录后跳转首页" --priority P0

# 4. 带页面探索的生成
auto-test generate "完整登录流程" --url https://example.com/login --priority P1

# 4b. 强制归类到 auth/login 模块（v2.1+）
auto-test generate "登录失败提示" --priority P1 --module 用户认证 --group auth

# 4c. 强制刷新探索快照（v2.1+）
auto-test generate "..." --url https://example.com/login --no-explore-cache

# 5. 列用例
auto-test list --priority P0
auto-test list --auth admin
auto-test list --module 用户认证 --group auth --json   # v2.1+ 按模块/分组过滤
# 6. 配置登录态（手写）
auto-test auth init admin
# 编辑 .auto-test/auth/admin.setup.ts 填登录步骤
auto-test auth refresh admin

# 7. 配置登录态（PI 生成）
auto-test auth generate "管理员登录：admin/admin123，登录成功跳转 dashboard" --name admin

# 8. 跑用例
auto-test run                          # 全部
auto-test run auth                    # 用例名前缀匹配
auto-test run --priority P0           # 冒烟
auto-test run --auth admin            # 仅 auth=admin 的用例
auto-test run --header "X-Tenant=qa"  # 临时注入 header
auto-test run --no-auth               # 公开页
auto-test run --label smoke           # v2.2+ 加批次语义标签，批次号: 2026-08-27_150059-smoke

# 9. CI 注入（推荐用 env）
AUTH_TOKEN=$STAGING_TOKEN auto-test run --priority P0

# 10. 查看与自愈
auto-test show auth/login-success
auto-test history --limit 5
auto-test rerun
auto-test heal auth/login-success
```

## 用例元数据（`.auto-test/cases/<group>/<name>.meta.json`）

```json
{
  "name": "auth/login-success",
  "description": "管理员登录成功跳转 dashboard",
  "priority": "P0",
  "group": "auth",
  "module": "用户认证",
  "linkedTickets": ["AUTH-101"],
  "auth": "admin",
  "tags": ["smoke", "happy-path"],
  ...
}
```

**字段约束**：
- `priority`: 必填枚举 `P0|P1|P2|P3`（CLI `--priority` 必传）
- `group`: 可选，kebab-case，物理子目录分组（如 `auth/login-success`）；CLI `--group` 显式传值时强制覆盖 PI 推断（不传则 PI 从需求推断）
- `module`: 可选，中文模块名（用于报告归类）；CLI `--module` 显式传值时强制覆盖 PI 推断
- `linkedTickets`: 可选，关联 Jira / 需求单号
- `auth`: 可选，引用 `auth/<name>.setup.ts` 的 storageState
-`tags`: 可选，小写 kebab-case

**归类约定**：
- `group` 与 `name` 的第一段必须一致（如 `name=auth/login-success` 时 `group=auth`），物理目录会落到 `.auto-test/cases/auth/login-success.{spec.ts,meta.json}`
- `group` / `module` / `linkedTickets` 三者协同：一个 group 下可有多个用例，共享同一 module 名；不同 group 不应共享 module 名
- 修复流程（heal）会保持 group / module / linkedTickets 不变

## 鉴权注入优先级链

```
CLI flag (--header / --storage-state / --no-auth)
  ↓
process.env (AUTO_TEST_HEADER_<KEY> / AUTO_TEST_STORAGE_STATE / AUTO_TEST_NO_AUTH / BASE_URL / AUTH_TOKEN)
  ↓
.auto-test/config.json 的 auth 段 (headers / extraHTTPHeaders / cookies / storageState)
  ↓
Playwright 默认值
```

`config.auth` 字段值支持 `${ENV_VAR}` 占位符，未设时 warning + 空串（fail-fast）。

## 探索快照缓存（v2.1+）

`generate --url` 默认会复用 `.auto-test/cache/explore/<hash>.json` 的 a11y 快照：

- **key** = `sha256(URL + storageState 文件指纹)`，相同 (URL, 角色) 直接复用
- **TTL** 默认 600000ms（10 分钟），过期或 storageState 变会自动失效
- **关闭方式**：`explore.cache.enabled = false` 全局关；`--no-explore-cache` 单次关；`rm -rf .auto-test/cache/explore/` 手动清空

**何时该强制刷新**：

- 页面结构发生变化（CSS 类、a11y role）
- 想验证最新 DOM
- 调试某个用例希望看原始快照

## 少样本示例库（v2.1+）

`src/agent/templates/` 内联 4 套场景完整样例：`login-flow` / `form-submit` / `list-search` / `detail-page`。`prompts.ts::pickExample()` 按描述关键词自动挑选作为 few-shot 注入 system prompt，输出风格更稳。

## 批次号与产物落点（v2.2+）

`run` 每次执行生成一个**批次号**（batchId）作为该次运行目录名：

```
YYYY-MM-DD_HHMMSS[-<slug>]
```

| 形态 | 示例 | 说明 |
|------|------|------|
| 默认 | `2026-08-27_150059` | 自带自然排序、shell 安全 |
| `--label <slug>` | `2026-08-27_150059-smoke` | 拼上 kebab-case 语义标签，便于识别 |
| 冲突 | `2026-08-27_150059-smoke-2` | 同 batchId 已存在时自动追加 `-2` / `-3` … |

**目录布局**：每次 `run` 在 `.auto-test/reports/runs/<batchId>/` 下产生三个产物：

```
.auto-test/reports/runs/<batchId>/
├── run.json                # auto-test 结构化历史
├── results.json            # Playwright JSON reporter 输出
└── artifacts/              # Playwright outputDir（screenshots/videos/traces）
```

**子进程 env（v2.3+）**：executor 通过 `src/runner/spawn-env.ts` 统一注入，包内 `playwright.config.ts` 消费。run / rerun / auth refresh 三入口协议一致：

- `AUTO_TEST_CASES_DIR` / `AUTO_TEST_AUTH_DIR` / `AUTO_TEST_CONFIG_PATH` → 用户路径（绝对）
- `AUTO_TEST_OUTPUT_DIR` / `AUTO_TEST_JSON_OUTPUT_FILE` → 批次产物落点
- `AUTO_TEST_RUN_ID` / `AUTO_TEST_REPORTS_DIR` → reporter 收尾
- `BASE_URL` → `AUTO_TEST_BASE_URL ?? 'http://localhost:3000'`（修 P0-1：executor 显式透传）
- `AUTO_TEST_BROWSER_CHANNEL` → `auto` 检测后的 `chrome` / `msedge`（未回退则不设）
- `AUTO_TEST_HEADER_*` / `AUTO_TEST_STORAGE_STATE` / `AUTO_TEST_NO_AUTH` → 鉴权注入

**`--label` 校验**：kebab-case（`^[a-z][a-z0-9-]*[a-z0-9]$`），长度 1–32。`smoke` / `p0-regression` / `nightly-batch-2` 都是合法 slug。

## 输出约定

- 所有命令支持 `--json` 输出
- 错误结构化: `{ ok: false, error: { code, message, hint } }`
- 退出码见 `src/utils/errors.ts`：USAGE_ERROR / NOT_FOUND / ALREADY_EXISTS / IO_ERROR / TEST_FAILED

## 最佳实践

1. **首次必跑 `models select`** — 选定 LLM provider / model
2. **`generate` 必传 `--priority`** — 避免 LLM 自由发挥污染冒烟集
3. **`generate` 可加 `--url` 探索页面**，提高定位准确度
4. **登录用例用 auth 子系统** — setup 文件 + storageState 复用，不重复登录
5. **CI 用 env 注入凭据** — `${AUTH_TOKEN}` 比硬编码安全
6. **`--json` 输出便于 agent 解析**
7. **`rerun` 一键重跑**失败用例
8. **`heal <name>`** 把失败用例 + 错误日志委托给 pi-agent 自动修复
9. **用例按 group 分目录** — `auth/login-success.spec.ts` 比 `login-success.spec.ts` 更易管理
