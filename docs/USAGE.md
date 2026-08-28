# specmint 使用文档（v2.1）

面向测试工程师的完整使用指南。

## 1. 项目布局

v2 强制所有产物在 `.specmint/` 下，项目根**零污染**。

```
my-project/
├── .gitignore                         # init 追加 .specmint/reports/ 等规则
└── .specmint/                         # specmint 全部产物
    ├── config.json                    # 项目配置（位置不可改）
    ├── cases/                          # 用例库（递归支持 group/）
    │   ├── auth/login-success.spec.ts
    │   └── auth/login-success.meta.json
    ├── cases/pages/                    # POM
    ├── auth/                           # 登录态子系统（按需生成 setup 文件）
    │   └── storage/<name>.json         # storageState（gitignore）
    ├── cache/                          # v2.1+ 探索快照缓存（gitignore）
    │   └── explore/<hash>.json         # key = hash(URL + storageState)
    └── reports/                        # 运行产物（gitignore）
        └── runs/<batchId>/             # 每次 run 一个独立批次目录
            ├── run.json                # specmint 结构化记录
            ├── results.json            # Playwright JSON reporter 输出
            └── artifacts/              # Playwright outputDir（screenshots/videos/traces）

> **包内配置接管（v2.2+）**：Playwright 配置不再生成于用户项目，统一在 `dist/runner/playwright.config.{js,ts}` 内由 specmint 自带。`.specmint/` 仅保留用户资产。深度自定义走 `specmint run --config <path>`。
```

**为什么不能改路径**：
- 减少决策成本（无需选择放在哪）
- 避免配置漂移（团队内机器一致）
- 项目根零污染（review 友好）

## 2. 配置（`.specmint/config.json`）

### 最小配置

```json
{
  "agent": { "model": "minimax-cn/MiniMax-M3", "delegate": "sdk" },
  "runner": { "defaultBrowser": "chromium" }
}
```

`agent.model` 必填（用 `specmint models select` 选，或手动从 pi-agent 复制）。

### 完整配置（含 v2.1 缓存）

```json
{
  "agent": {
    "model": "anthropic/claude-sonnet-latest",
    "delegate": "sdk",
    "systemPromptAdditions": ""
  },
  "explore": {
    "enabledByDefault": false,
    "headless": true,
    "timeoutMs": 15000,
    "maxElements": 200,
    "waitUntil": "domcontentloaded",
    "cache": {
      "enabled": true,
      "ttlMs": 600000,
      "dir": ".specmint/cache/explore"
    }
  },
  "generation": {
    "selectorPolicy": {
      "prefer": ["getByRole", "getByLabel", "getByPlaceholder", "getByTestId"],
      "avoid": ["nth-child", "nth-of-type", "complex-css", "xpath"]
    },
    "language": "zh",
    "comments": "verbose",
    "style": "page-object-optional"
  },
  "runner": {
    "defaultBrowser": "chromium",
    "trace": "retain-on-failure",
    "screenshot": "only-on-failure",
    "timeoutMs": 30000,
    "browserChannel": "auto"
  },
  "auth": {
    "headers": { "X-Tenant": "qa" },
    "extraHTTPHeaders": { "Authorization": "Bearer ${AUTH_TOKEN}" },
    "cookies": [],
    "storageState": ".specmint/auth/storage/default.json"
  }
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `agent.model` | 否 | pi-agent model id。未设时自动选第一个 available。 |
| `agent.delegate` | 否 | `sdk` \| `cli`，默认 `sdk` |
| `runner.defaultBrowser` | 否 | `chromium`（v2.2+ 限定，扩展浏览器类型见 roadmap） |
| `runner.trace` | 否 | `retain-on-failure`（默认）/ `on-first-retry` / `off` —— 控制失败 trace 落盘策略 |
| `runner.screenshot` | 否 | `only-on-failure`（默认）/ `on` / `off` |
| `runner.timeoutMs` | 否 | 单用例超时（毫秒），默认 `30000` |
| `runner.browserChannel` | 否 | `auto`（默认，chromium→chrome→msedge 自动回退）/ `chromium` / `chrome` / `msedge` —— 解决内网无法下载 chromium |
| `runner.baseURL` | 否 | 被测目标 baseURL，注入到 Playwright `use.baseURL`。支持 `${ENV_VAR}` 展开。env 优先于本字段（`BASE_URL` / `SPECMINT_BASE_URL` > `runner.baseURL` > `http://localhost:3000`） |
| `auth.headers` | 否 | 注入到 Playwright `extraHTTPHeaders` |
| `auth.extraHTTPHeaders` | 否 | 同 `headers`，两者合并 |
| `auth.cookies` | 否 | cookie 列表（schema 预留，阶段 2 完整支持） |
| `auth.storageState` | 否 | Playwright `storageState` 路径 |
| `explore.cache.enabled` | 否 | 是否启用探索快照缓存，默认 `true` |
| `explore.cache.ttlMs` | 否 | 快照有效期（毫秒），默认 `600000`（10 分钟） |
| `explore.cache.dir` | 否 | 缓存目录，相对 `.specmint/` 解析 |

## 3. 用例元数据

`.specmint/cases/<group>/<name>.meta.json`：

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
  "createdAt": "2026-08-27T...",
  "updatedAt": "2026-08-27T...",
  ...
}
```

### 字段约束

| 字段 | 必填 | 校验 |
|------|------|------|
| `name` | 是 | kebab-case，可含 `group/name` 形式 |
| `priority` | **是** | enum `P0\|P1\|P2\|P3` |
| `group` | 否 | kebab-case（物理子目录分组）|
| `module` | 否 | 中文模块名 |
| `linkedTickets` | 否 | 字符串数组 |
| `auth` | 否 | 引用 `auth/<name>.setup.ts` 产物 |
| `tags` | 否 | 小写 kebab-case 数组 |

### 用例名分组

物理分层（推荐用于 50+ 用例）：

```
.specmint/cases/
├── auth/
│   ├── login-success.spec.ts
│   └── login-invalid.spec.ts
├── checkout/
│   ├── cart-add.spec.ts
│   └── payment-fail.spec.ts
└── public/
    └── homepage.spec.ts
```

用例名 = `auth/login-success`，PI 生成时 PI 自动推断 group + module。

### CLI 覆盖 PI 输出（v2.1+）

如果 PI 推断的 `group` / `module` 不符合期望，generate 命令支持直接锁定：

```bash
specmint generate "登录失败提示" --priority P1 \
  --group auth --module 用户认证
```

覆盖后的值不经过归一化层，直接落盘到 meta.json，并决定物理目录结构。

## 4. 命令清单

### 初始化

```bash
specmint init                 # 创建 .specmint/ 布局
specmint init --force         # 强制覆盖已存在的配置
```

### 模型选择

```bash
specmint models list                    # 列可用（已登录）
specmint models list --all              # 列全部（含未登录）
specmint models current                 # 查看当前
specmint models select                  # 交互式选择
```

### 用例库

```bash
# 生成（v2.1 增加 --module / --group / --no-explore-cache）
specmint generate "<desc>" --priority P0
specmint generate "<desc>" --priority P1 --url https://example.com --page-object
specmint generate "<desc>" --priority P0 --module 用户认证 --group auth
specmint generate "<desc>" --priority P0 --no-explore-cache   # 强制刷新探索快照

# 列表（v2.1 增加 --module / --group）
specmint list [--tag X] [--priority P0,P1] [--auth admin]
specmint list --module 用户认证 --group auth --json

specmint show auth/login-success
specmint delete auth/login-success
```

### 登录态（auth 子系统）

```bash
specmint auth init admin               # 生成手写模板
specmint auth generate "<desc>" --name admin    # PI 生成
specmint auth refresh admin            # 重跑 setup → 生成 storageState
specmint auth list                     # 列所有 setup + 状态
```

### 运行

```bash
specmint run                                    # 全部
specmint run auth                               # 用例名前缀
specmint run --priority P0                      # 冒烟
specmint run --auth admin                       # auth=admin 的用例
specmint run --header "X-Tenant=qa"             # 临时 header
specmint run --storage-state <path>             # 临时 storageState
specmint run --no-auth                          # 公开页
specmint run --label smoke                      # 批次号尾部加语义标签：2026-08-27_150059-smoke
specmint rerun                                  # 重跑最近失败
specmint rerun --from <runId>                   # 指定 run
specmint history --limit 10                     # 历史
specmint heal auth/login-success                # 自愈
```

## 5. 鉴权注入（方式 C 详解）

### 优先级链

```
CLI flag (--header / --storage-state / --no-auth)
  ↓
process.env (SPECMINT_HEADER_<KEY> / SPECMINT_STORAGE_STATE / SPECMINT_NO_AUTH / BASE_URL / AUTH_TOKEN)
  ↓
.specmint/config.json 的 auth 段
  ↓
Playwright 默认值
```

### `${ENV_VAR}` 插值

`auth` 段字段值支持 `${ENV_VAR}` 占位符（仅 auth 段允许，path 字段不允许）：

```json
{
  "auth": {
    "extraHTTPHeaders": {
      "Authorization": "Bearer ${AUTH_TOKEN}"
    }
  }
}
```

`process.env.AUTH_TOKEN` 未设时：**warning + 空串**（fail-fast 让 CI 立刻知道配置问题）。

### CI 集成

```yaml
# .github/workflows/e2e.yml
- name: E2E
  run: |
    npx specmint auth refresh admin    # 重新生成 storageState
    npx specmint run --priority P0
  env:
    AUTH_TOKEN: ${{ secrets.STAGING_TOKEN }}
    BASE_URL: ${{ vars.STAGING_URL }}
```

## 6. 登录态管理（auth 子系统）

### 目录约定

```
.specmint/auth/
├── admin.setup.ts                # 登录流程（手写或 PI 生成）
├── anonymous.setup.ts            # 访客态
└── storage/
    ├── admin.json                # setup 产物（gitignore）
    └── anonymous.json
```

### 两种用法

**手写**（最快上手）：
```bash
specmint auth init admin
# 编辑 .specmint/auth/admin.setup.ts
specmint auth refresh admin
```

**PI 生成**：
```bash
specmint auth generate "管理员登录：admin/admin123，登录成功跳转 dashboard" --name admin
specmint auth refresh admin
```

### Playwright 自动配置（v2.2+）

Playwright 配置由 specmint 包内自带（`dist/runner/playwright.config.{js,ts}`），**不再生成于用户目录**。
executor 通过 `import.meta.url` 定位并 `--config` 指向它，所有用户路径通过 `SPECMINT_*` env 注入。

projects 结构（动态挂载）：

```typescript
// 检测到 *.setup.ts 时才挂 auth-setup project，连同 chromium 一起跑
projects: hasSetupFiles
  ? [{ name: 'auth-setup', testMatch: /\.setup\.ts$/, testDir: '.specmint/auth' },
     { name: 'chromium', testDir: '.specmint/cases', dependencies: ['auth-setup'] }]
  : [{ name: 'chromium', testDir: '.specmint/cases' }]
```

`auth-setup` project 仅在存在 setup 文件时挂载（根治两个独立 bug：占位 setup 失败连坐 / 无 setup 时跑空）。
写了 setup文件即自动生效；按需用 `specmint auth init <name>` 生成。

### 用例关联 auth

`meta.json` 加 `auth: "<name>"`：

```json
{ "name": "dashboard/overview", "priority": "P0", "auth": "admin" }
```

跑用例：

```bash
specmint run --auth admin
```

自动：
1. 过滤 `meta.auth === "admin"` 的用例
2. 注入 storageState = `.specmint/auth/storage/admin.json`

## 7. PI 输出契约（generate）

`generate` 命令 prompt 里硬约束 LLM：
- `priority` 必须用 enum（PI 不能改，由 CLI `--priority` 锁定）
- `group` 必须是 kebab-case
- `module` 用中文
- `linkedTickets` 是字符串数组
- `tags` 是小写 kebab-case

LLM 输出仍可能不规范，**归一化层兜底**（`src/utils/normalize-meta.ts`）：
- `"高"` / `p0` / `"urgent"` / `"critical"` → `P0`
- `"中"` / `"medium"` → `P2`
- 其他不规范字段 → warning + 忽略（不阻塞保存）

**严格校验**（落盘前 `src/utils/case-schema.ts`）：
- `name` / `priority` 不合规 → throw（必填 + 强 enum）
- `group` / `module` / `linkedTickets` / `tags` → warning + 跳过

**CLI 强制覆盖（v2.1+）**：

```bash
specmint generate "登录失败提示" \
  --priority P1 \
  --module 用户认证 \
  --group auth
```

`--module` 和 `--group` 会在 prompt 里以最高优先级告知 PI，绕过归一化层直接落盘，避免 PI 自由发挥产生脏目录。

## 8. 探索快照缓存（v2.1+）

### 用途

`generate --url` 在浏览器里打开 URL、抓 a11y 快照再让 LLM 看。当一个 URL 被反复生成（同一页面不同用例）时，每次都开浏览器很慢。

v2.1 把 `(URL + storageState)` 的快照落盘到 `.specmint/cache/explore/`，TTL 内复用。

### 启用 / 禁用

- 默认 `explore.cache.enabled = true`
- 全局关闭：`explore.cache.enabled = false`
- 单次跳过：`specmint generate ... --no-explore-cache`
- 手动清理：删除 `.specmint/cache/` 或 `rm -rf .specmint/cache/explore/*`

### 命中判定

缓存 key = `sha256(URL + storageState)`（按文件指纹 / mtime 计算），相同 (URL, 角色) 才命中：

```
URL: https://example.com/login  +  storageState: .specmint/auth/storage/admin.json
  → cache/explore/<hash>.json
```

storageState 变化（例如切换 `auth/admin` → `auth/anonymous`）会自动失效。

### 何时该强制刷新

- 后端页面结构发生变化（CSS 类、a11y role 等）
- 想验证最新 DOM 是否有新元素
- 调试某个用例时希望看到原始快照

加 `--no-explore-cache` 或 `rm` 对应 `.json` 即可。

## 9. 少样本示例库（v2.1+）

`src/agent/templates/` 内联了 4 套场景的完整样例（`login-flow` / `form-submit` / `list-search` / `detail-page`），`prompts.ts` 的 `pickExample()` 会按描述关键词自动挑选一个塞进 system prompt，作为 few-shot。

挑选规则（关键词命中优先级）：
1. 包含 "登录 / login / signin" → `login-flow`
2. 包含 "提交 / 表单 / submit / form" → `form-submit`
3. 包含 "列表 / 搜索 / list / search" → `list-search`
4. 包含 "详情 / detail" → `detail-page`
5. 兜底：`form-submit`

样式更稳；用户可用 `--example <name>` 显式指定走某个场景，`--no-example` 关闭注入。

## 10. 批次号与产物落点

`run` 命令每次执行都会生成一个**批次号**（batchId）作为该次运行的目录名。Playwright 的所有产物（screenshots / videos / traces）也按批次号组织，不再污染项目根。

### batchId 格式

```
YYYY-MM-DD_HHMMSS[-<slug>]
```

| 形态 | 示例 | 说明 |
|------|------|------|
| 默认 | `2026-08-27_150059` | 短、自带自然排序、shell 安全 |
| 带 `--label` | `2026-08-27_150059-smoke` | 拼上 kebab-case 语义标签，便于一眼识别 |
| 冲突 | `2026-08-27_150059-smoke-2` | 同 batchId 已存在时自动追加 `-2` / `-3` … |

### 目录布局

每次 `run` 在 `.specmint/reports/runs/<batchId>/` 下产生三个产物：

```
.specmint/reports/runs/<batchId>/
├── run.json                # specmint 结构化历史（runId / label / cases / totals / results）
├── results.json            # Playwright JSON reporter 输出
└── artifacts/              # Playwright outputDir（screenshots / videos / traces）
    └── <test-name>-.../
```

### 子进程 env 注入（v2.2+）

executor 在 spawn `playwright test` 前注入完整 env 协议（**统一收口于 `src/runner/spawn-env.ts`，run/rerun/auth refresh 三入口共用**）：

| env | 值 | 用途 |
|-----|----|------|
| `SPECMINT_CASES_DIR` | `.specmint/cases`（绝对路径） | 用例目录 |
| `SPECMINT_AUTH_DIR` | `.specmint/auth`（绝对路径） | 登录态 setup 目录 |
| `SPECMINT_CONFIG_PATH` | `.specmint/config.json`（绝对路径） | 包内配置读取 |
| `SPECMINT_OUTPUT_DIR` | `.specmint/reports/runs/<batchId>/artifacts` | trace/screenshot 落点 |
| `SPECMINT_JSON_OUTPUT_FILE` | `.specmint/reports/runs/<batchId>/results.json` | JSON reporter 输出 |
| `SPECMINT_RUN_ID` | `<batchId>` | reporter 收尾 |
| `SPECMINT_REPORTS_DIR` | `.specmint/reports`（绝对路径） | reporter history store |
| `BASE_URL` | `SPECMINT_BASE_URL ?? SPECMINT_BASE_URL ?? 'http://localhost:3000'` | 修 P0-1：透传给子进程 |
| `SPECMINT_BROWSER_CHANNEL` | `auto` 检测后的回退结果（`chrome` / `msedge`，未回退则不设） | 浏览器通道 |
| `SPECMINT_HEADER_*` | `--header K=V` 注入 | 鉴权头部 |
| `SPECMINT_STORAGE_STATE` | `--storage-state` 路径 | 登录态注入 |
| `SPECMINT_NO_AUTH` | `1`（当 `--no-auth`） | 跳过 storageState |

env 缺失时统一回退 `cwd/.specmint/*`（不依赖 `__dirname`，npx 安装与 dist 状态行为一致）。

### `--label` 校验

- kebab-case：`^[a-z][a-z0-9-]*[a-z0-9]$`
- 长度 1–32
- 合法示例：`smoke`、`p0-regression`、`nightly-batch-2`
- 非法示例：`Smoke`（大写）、`-smoke`（开头 `-`）、`smoke-`（结尾 `-`）、`smoke--batch`（连续 `-`）

### 历史查看

```bash
specmint history --limit 5
# batchId              label    status    totals           startedAt
# 2026-08-27_150059    smoke    passed    12/12 (1.5s)    2026-08-27T15:00:59Z
# 2026-08-27_142301    p0       failed    3/5 (8.2s)      2026-08-27T14:23:01Z
# ...
```

按 batchId 排序（字典序），所以日期从早到晚自然展开。

### 何时该清理 `.specmint/reports/runs/`

- 旧 run 已不再需要（参考 `history --limit N`）
- 磁盘吃紧
- CI 流水线可在每次 pipeline 起点 `rm -rf .specmint/reports/runs/*` 强制冷启动

## 11. 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 2 (USAGE_ERROR) | 参数错误 |
| 3 (NOT_IMPLEMENTED) | 子命令未实现 |
| 4 (NOT_FOUND) | 资源不存在 |
| 5 (ALREADY_EXISTS) | 重复创建 |
| 6 (AGENT_ERROR) | PI 调用失败 |
| 7 (TEST_FAILED) | 测试失败 |
| 8 (IO_ERROR) | IO 错误 |

## 12. 常见问题

### Q：路径能改成 `e2e/` 吗？

**不能**。v2 强制 `.specmint/`，避免配置漂移。

### Q：priority 必须是 P0-P3 吗？

是的。`generate --priority` 必填枚举。如果 PI 自由发挥会污染冒烟集。

### Q：项目根污染怎么办？

v2 后不存在。**老项目**手动删 `tests/`、`reports/`、`specmint.config.json`（项目根），然后跑 `specmint init` 重建。

### Q：需要多角色怎么办？

v2 默认单一角色。流程：
1. 先用一个角色跑完所有用例
2. `specmint auth refresh <next-role>`
3. 跑另一角色用例

不同角色在不同测试批次切换，不并发。

### Q：CI 怎么注入 token？

`auth` 段写 `"Authorization": "Bearer ${AUTH_TOKEN}"`，CI 设 `AUTH_TOKEN` 环境变量即可。无需改代码。

### Q：LLM 不可用怎么办？

`specmint models list` 看哪些 provider/model 已登录。未登录的 provider 需要在 pi-agent 里 `/login` 配置 API key。

### Q：PI 生成的 priority 不对？

强制约束在 `--priority` 锁定。如果发现 PI 输出 P1 但 CLI 传 P0，检查 `src/agent/tools.ts` 的 `save_case.execute`：应使用 `ctx.defaultPriority`。

### Q：PI 生成的 group 不对怎么办（v2.1+）？

generate 命令支持 `--group` / `--module` 强制锁定，传了之后跳过归一化层直接落盘：

```bash
specmint generate "登录失败提示" --priority P1 --group auth --module 用户认证
```

### Q：探索快照多久失效？

`explore.cache.ttlMs` 默认 600000ms（10 分钟）。过期或 storageState 改变都会自动重建。

### Q：能关掉探索快照缓存吗？

- 配置：`explore.cache.enabled = false`
- 单次：`specmint generate ... --no-explore-cache`
- 物理：`rm -rf .specmint/cache/explore/`

## 13. 升级指南

### v1 → v2

1. 删项目根的 `specmint.config.json` 和 `playwright.config.ts`
2. 删项目根的 `tests/` 和 `reports/`（如有）
3. 跑 `specmint init` 重建 `.specmint/` 布局
4. 跑 `specmint models select` 选 LLM
5. 跑 `specmint auth init <role>`（如需登录态）
6. 跑 `specmint generate "<desc>" --priority P0` 开始

### v2 → v2.1

完全向后兼容：

- 首次运行会自动创建 `.specmint/cache/`
- 旧项目无 `explore.cache` 配置时取默认值（启用、TTL 10 分钟）
- 想强制冷启动：`rm -rf .specmint/cache/`

### v2.1 → v2.2（批次号与产物落点）

完全向后兼容。Playwright 产物（screenshots / videos / traces / JSON 报告）现在按批次号落在 `.specmint/reports/runs/<batchId>/artifacts/` 和 `<batchId>/results.json`，不再写到项目根的 `test-results/`。

升级步骤：

1. **用户项目**的 `.gitignore` 里 `.specmint/reports/runs/` 会覆盖之前的 `.specmint/reports/runs/*/.tmp/`，如果之前手写过旧规则可以删除
2. **用户项目**的 `playwright.config.ts`（在 `.specmint/` 下）会被 `init` 重新生成；如已自改，请手动加入 `outputDir: process.env.SPECMINT_OUTPUT_DIR ?? './test-results'` 与 `outputFile: process.env.SPECMINT_JSON_OUTPUT_FILE`
3. 如果之前项目根有遗留的 `test-results/` / `playwright-report/`，手动 `rm -rf` 清理一次即可
4. 旧的 `.specmint/reports/runs/<ISO 时间戳>/` 目录仍然可用（路径格式升级为 `YYYY-MM-DD_HHMMSS` 但目录布局兼容）
