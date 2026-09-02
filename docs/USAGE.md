# specmint 使用文档（v2.7）

面向测试工程师的完整使用指南。

> v2.7 增量 A（v0.5.1）：Windows 全平台兼容（spawn / 路径 / reviewer / NTFS / 构建脚本 5 处 P0/P2 修复）。
> v2.7 增量 B（v0.5.2）：`run` / `rerun` 执行集修复——verdict 卡口开启时全量跑与派生分支不再报 "No tests found"、`rerun` 多条失败用例修复、嵌套同名串扰修复、单文件直传路径卡口修复。
> 详见 [§13 升级指南](#13-升级指南)。

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
    ├── cache/                          # v0.2.0+ 探索快照缓存（gitignore）
    │   └── explore/<hash>.json         # key = hash(URL + storageState)
    └── reports/                        # 运行产物（gitignore）
        └── runs/<batchId>/             # 每次 run 一个独立批次目录
            ├── run.json                # specmint 结构化记录
            ├── results.json            # Playwright JSON reporter 输出
            └── artifacts/              # Playwright outputDir（screenshots/videos/traces）

> **包内配置接管（v0.2.0+）**：Playwright 配置不再生成于用户项目，统一在 `dist/runner/playwright.config.{js,ts}` 内由 specmint 自带。`.specmint/` 仅保留用户资产。深度自定义走 `specmint run --config <path>`。
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
| `runner.defaultBrowser` | 否 | `chromium`（v0.2.0+ 限定，扩展浏览器类型见 roadmap） |
| `runner.trace` | 否 | `retain-on-failure`（默认）/ `on-first-retry` / `off` —— 控制失败 trace 落盘策略 |
| `runner.screenshot` | 否 | `only-on-failure`（默认）/ `on` / `off` |
| `runner.timeoutMs` | 否 | 单用例超时（毫秒），默认 `30000` |
| `runner.browserChannel` | 否 | `auto`（默认，chromium→chrome→msedge 自动回退）/ `chromium` / `chrome` / `msedge` —— 解决内网无法下载 chromium |
| `runner.baseURL` | 否 | 被测目标 baseURL，注入到 Playwright `use.baseURL`。支持 `${ENV_VAR}` 展开。env 优先于本字段（`BASE_URL` / `SPECMINT_BASE_URL` > `runner.baseURL` > `http://localhost:3000`） |
| `auth.headers` | 否 | 注入到 Playwright `extraHTTPHeaders`（v0.5.0 起 `generate` 探索阶段同样生效） |
| `auth.extraHTTPHeaders` | 否 | 同 `headers`，两者合并 |
| `auth.cookies` | 否 | cookie 列表（v0.5.0 起 `generate` 探索阶段作为最弱兜底注入，仅在无 storageState 时生效） |
| `auth.storageState` | 否 | Playwright `storageState` 路径。**v0.5.0 起 `generate --url` 探索阶段自动注入**（优先级：CLI `--auth <role>` > 本字段 > headers/cookies > 未登录态+warning）；value 支持 `${ENV_VAR}` 展开 |
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

### CLI 覆盖 PI 输出（v0.2.0+）

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
# v0.5.0 登录态注入：--auth <role> 覆盖 config.auth.storageState（多角色用）
specmint generate "<desc>" --priority P0 --url https://example.com/dashboard --auth admin

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
specmint run "classes/"                         # 目录/路径前缀（走 caseStore.list 派生 + verdict 卡口）
specmint run --priority P0                      # 冒烟
specmint run --module 用户认证                  # 按模块中文名过滤（meta.module 精确匹配）
specmint run --group auth                       # 按 group 过滤（meta.group 或 name 第一段前缀）
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

### Playwright 自动配置（v0.2.0+）

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

**CLI 强制覆盖（v0.2.0+）**：

```bash
specmint generate "登录失败提示" \
  --priority P1 \
  --module 用户认证 \
  --group auth
```

`--module` 和 `--group` 会在 prompt 里以最高优先级告知 PI，绕过归一化层直接落盘，避免 PI 自由发挥产生脏目录。

## 8. 探索快照缓存（v0.2.0+）

### 用途

`generate --url` 在浏览器里打开 URL、抓 a11y 快照再让 LLM 看。当一个 URL 被反复生成（同一页面不同用例）时，每次都开浏览器很慢。

v2.1 把 `(URL + storageState)` 的快照落盘到 `.specmint/cache/explore/`，TTL 内复用。

### 启用 / 禁用

- 默认 `explore.cache.enabled = true`
- 全局关闭：`explore.cache.enabled = false`
- 单次跳过：`specmint generate ... --no-explore-cache`
- 手动清理：删除 `.specmint/cache/` 或 `rm -rf .specmint/cache/explore/*`

### 命中判定

缓存 key = `sha256(URL + 探索参数 + storageStateFingerprint)`。v0.5.0 起登录态参与 key 的方式升级为**指纹**（`storageStateFingerprint`）：由 storageState 路径或 headers/cookies 的 key 名 hash 而来（**绝不 hash value**，避免 secret 泄露到缓存 key）。相同 (URL, 登录态指纹) 才命中：

```
URL: https://example.com/login  +  storageState: .specmint/auth/storage/admin.json
  → fingerprint: 3f2a9c1e
  → cache/explore/<hash>.json

同 URL 换角色（--auth viewer）→ fingerprint 不同 → 缓存自动失效重抓
```

storageState 切换（例如 `--auth admin` → `--auth viewer`）会自动失效。v0.5.0 之前的旧缓存（无指纹）视为"未登录态"快照，带登录态的新调用会重新抓一次，无需手动清理。

### 何时该强制刷新

- 后端页面结构发生变化（CSS 类、a11y role 等）
- 想验证最新 DOM 是否有新元素
- 调试某个用例时希望看到原始快照

加 `--no-explore-cache` 或 `rm` 对应 `.json` 即可。

## 9. 少样本示例库（v0.2.0+）

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

### 子进程 env 注入（v0.3.0+）

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

### Q：PI 生成的 group 不对怎么办（v0.2.0+）？

generate 命令支持 `--group` / `--module` 强制锁定，传了之后跳过归一化层直接落盘：

```bash
specmint generate "登录失败提示" --priority P1 --group auth --module 用户认证
```

### Q：探索快照多久失效？

`explore.cache.ttlMs` 默认 600000ms（10 分钟）。过期或 storageState 改变都会自动重建。

### Q：generate 时 URL 需要登录态怎么办（v0.5.0+）？

三种方式，优先级从高到低：

```bash
# 1. CLI 显式覆盖（多角色推荐）
specmint generate "<desc>" --url https://example.com/dashboard --auth admin

# 2. config 默认（项目级单一身份）
# .specmint/config.json: { "auth": { "storageState": ".specmint/auth/storage/admin.json" } }
specmint generate "<desc>" --url https://example.com/dashboard

# 3. token 头兜底（CI 场景，value 支持 ${ENV_VAR}）
# { "auth": { "headers": { "Authorization": "Bearer ${CI_TOKEN}" } } }
```

都没配时不会 fail：先打一条 warning，探索完成后若命中启发式登录页探测（title/URL 含 login/signin/oauth/sso/登录，或快照含 `type=password`）再补一条 warning，照常按未登录态生成。端到端演示见 [examples/with-auth](../examples/with-auth/)。

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

### v2.5 → v2.6（generate 登录态注入）

完全向后兼容，零迁移成本。`generate --url` 探索阶段现在会真正向 Playwright 注入登录态（此前需登录的 URL 拿到的是未登录 DOM）：

- **新能力**：CLI `--auth <role>` 显式覆盖 / `config.auth.storageState` 默认透传 / headers/cookies 兜底 / `generation.usedAuth` 审计字段（仅存 role/路径/key，token 不落盘）
- **行为变化**：未配置 auth 时会多一行 warning（旧版静默）；命中登录页启发式探测（login/signin/oauth/sso/登录/password input）再补一条——都不 fail
- **缓存自然失效**：旧无指纹缓存视为"未登录态"快照，带登录态的新调用重新抓一次，无需手动清理
- 端到端演示：[examples/with-auth](../examples/with-auth/)

### v2.6 → v2.7（Windows 全平台兼容）

完全向后兼容，零迁移成本。修复点（按严重度）：

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| P0-1 | `src/runner/executor.ts:186` | `spawn('npx', ...)` 不带 `shell`，Windows 上找不到 `npx.cmd` → `ENOENT` | 统一走 `src/utils/cross-platform.ts:spawnProcess()`，自动加 `shell: true` |
| P0-2 | `src/commands/auth.ts:211` | 同上，`auth refresh` 在 Windows 必挂 | 同上 |
| P0-3 | `src/commands/auth.ts:124` | `replace(cwd + '/', '')` 假设正斜杠，Windows 下 `storageRel` 残留为绝对路径并写入 setup.ts 模板 | 改用 `path.relative(cwd, ...).replace(/\\/g, '/')`（与 `case-store.ts:72,231` 同款范式） |
| P1 | `src/runner/review.ts:437` | `process.env.USER` Windows 上不存在，reviewer 静默退化为 `'unknown'` | 改为 `process.env.USERNAME \|\| process.env.USER` |
| P2 | `src/store/case-store.ts:678` | `entry === 'pages'` 大小写敏感，NTFS 大小写不敏感的目录名（如 `Pages/`）会被误扫进 POM 扫描 | lower-case 比对 |
| P2 | `package.json:18` | `build` 脚本裸调 `chmod`，Windows dev/CI 构建即挂 | 移除 chmod（dist 已在 `.gitignore`，无需执行权限位） |

升级步骤：

1. 拉取 v0.5.1：`npm i specmint@0.5.1`
2. **无需改动业务代码** —— 修复都在 CLI 内部
3. Windows 用户验证：
   ```powershell
   # 之前必挂，现在应通过
   npx specmint run --priority P0
   npx specmint auth refresh admin
   # 确认生成的 .specmint/auth/<role>.setup.ts 中路径是相对且正斜杠
   ```

兼容性边界：

- 子进程启动走 `src/utils/cross-platform.ts` 的 `spawnProcess()`，全平台一致行为
- 路径字符串统一用 `path.posix` 归一化（新增 `src/utils/path-display.ts`），setup.ts 模板里出现的路径都是 `relative/forward/slash` 形式
- 旧版本用户在 Windows 上 `.specmint/auth/<role>.setup.ts` 残留的绝对路径需要手动重跑 `specmint auth init <role>` 重新生成

### v2.7 增量 B（run / rerun 执行集修复）

完全向后兼容，零迁移成本。修复点（按严重度）：

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| P0-1 | `src/commands/run.ts` 全量跑 / `--priority` / `--auth` / `--module` / `--group` 派生分支 | verdict 卡口开启时把 case 内部名（kebab-case）当 `--grep` 传给 Playwright，但 `--grep` 只匹配测试 full title（中文场景名），**所有平台**都报 "No tests found" | 改用 Playwright 的 **positional args**（`patterns`，按文件路径正则匹配），与 `<casesDir>/<name>.spec.ts` 一一对应 |
| P0-2 | `src/commands/rerun.ts` | 多条失败用例用空格 join 成**单个** pattern（一个 argv 元素、路径里带空格的正则），必报 "No tests found" | 改为 patterns 数组逐条传递 |
| P1 | `src/commands/run.ts` | `<name>.spec.ts` 形式的 pattern 会作为后缀子串误命中嵌套同名用例（`login-success` 误跑 `auth/login-success`） | pattern 改用完整 `specPath`（相对 cwd、正斜杠）+ 逐字符转义 + `$` 锚定 |
| P2 | `src/commands/run.ts` | 单文件直传（`specmint run <path>`）时，Windows 反斜杠 / 绝对路径 / macOS `/tmp` 软链会让 verdict 反查命不中，卡口被**静默绕过** | 统一 `realpath` → `resolve` → `relative` → 正斜杠归一化后再反查；命不中库内用例时给出 INFO 提示 |

升级步骤：

1. 拉取 v0.5.2：`npm i specmint@0.5.2`
2. **无需改动业务代码** —— 修复都在 CLI 内部
3. 验证（review 卡口开启的项目）：

   ```bash
   # 之前必报 "No tests found"，现在应按 verdict 过滤后正常执行
   npx specmint run
   npx specmint run --priority P0
   npx specmint rerun          # 有多条失败用例时
   ```

行为变化：

- `run` 的无参数全量跑现在**真正生效 verdict 卡口**（此前裸 `specmint run` 会绕过卡口，把 pending / needs-fix / rejected 一起跑掉）
- 嵌套同名用例（`login-success` 与 `auth/login-success`）互不串扰，`specmint run login-success` 只跑根级那条
- `specmint run <绝对路径或反斜杠路径>` 现在会正确走 verdict 卡口（此前静默跳过检查）

---

## 附录 A：Playwright 版本对应

| specmint 版本 | 推荐 Playwright | 备注 |
|---|---|---|
| v0.1.0 – v0.2.x | `@playwright/test` ^1.40 | 经典双 layer 架构 |
| v0.3.0+        | `@playwright/test` ^1.40 | 包内 `playwright.config.ts`，executor 通过 `import.meta.url` 定位 |

升级 specmint 到 v0.3.0+ 不要求用户项目再持有 `playwright.config.ts`，但若有自定义项（如视口 / trace 开关），可在用户项目根目录新建 `playwright.config.ts`，executor 会自动 `--config <用户配置>` 优先于包内配置。

详细落点规则见本文第 9 节"批次号与产物落点"。
