# auto-test 使用文档（v2.1）

面向测试工程师的完整使用指南。

## 1. 项目布局

v2 强制所有产物在 `.auto-test/` 下，项目根**零污染**。

```
my-project/
├── .gitignore                         # init 追加 .auto-test/reports/ 等规则
└── .auto-test/                         # auto-test 全部产物
    ├── config.json                    # 项目配置（位置不可改）
    ├── playwright.config.ts           # Playwright 配置（位置不可改）
    ├── cases/                          # 用例库（递归支持 group/）
    │   ├── auth/login-success.spec.ts
    │   └── auth/login-success.meta.json
    ├── cases/pages/                    # POM
    ├── auth/                           # 登录态子系统
    │   ├── admin.setup.ts              # 登录流程
    │   └── storage/admin.json          # storageState（gitignore）
    ├── cache/                          # v2.1+ 探索快照缓存（gitignore）
    │   └── explore/<hash>.json         # key = hash(URL + storageState)
    └── reports/                        # 运行产物（gitignore）
        └── runs/<ts>/run.json
```

**为什么不能改路径**：
- 减少决策成本（无需选择放在哪）
- 避免配置漂移（团队内机器一致）
- 项目根零污染（review 友好）

## 2. 配置（`.auto-test/config.json`）

### 最小配置

```json
{
  "agent": { "model": "minimax-cn/MiniMax-M3", "delegate": "sdk" },
  "runner": { "defaultBrowser": "chromium" }
}
```

`agent.model` 必填（用 `auto-test models select` 选，或手动从 pi-agent 复制）。

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
      "dir": ".auto-test/cache/explore"
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
    "trace": "on-first-retry",
    "screenshot": "only-on-failure"
  },
  "auth": {
    "headers": { "X-Tenant": "qa" },
    "extraHTTPHeaders": { "Authorization": "Bearer ${AUTH_TOKEN}" },
    "cookies": [],
    "storageState": ".auto-test/auth/storage/default.json"
  }
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `agent.model` | 否 | pi-agent model id。未设时自动选第一个 available。 |
| `agent.delegate` | 否 | `sdk` \| `cli`，默认 `sdk` |
| `runner.defaultBrowser` | 否 | `chromium` \| `firefox` \| `webkit` |
| `auth.headers` | 否 | 注入到 Playwright `extraHTTPHeaders` |
| `auth.extraHTTPHeaders` | 否 | 同 `headers`，两者合并 |
| `auth.cookies` | 否 | cookie 列表（schema 预留，阶段 2 完整支持） |
| `auth.storageState` | 否 | Playwright `storageState` 路径 |
| `explore.cache.enabled` | 否 | 是否启用探索快照缓存，默认 `true` |
| `explore.cache.ttlMs` | 否 | 快照有效期（毫秒），默认 `600000`（10 分钟） |
| `explore.cache.dir` | 否 | 缓存目录，相对 `.auto-test/` 解析 |

## 3. 用例元数据

`.auto-test/cases/<group>/<name>.meta.json`：

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
.auto-test/cases/
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
auto-test generate "登录失败提示" --priority P1 \
  --group auth --module 用户认证
```

覆盖后的值不经过归一化层，直接落盘到 meta.json，并决定物理目录结构。

## 4. 命令清单

### 初始化

```bash
auto-test init                 # 创建 .auto-test/ 布局
auto-test init --force         # 强制覆盖已存在的配置
```

### 模型选择

```bash
auto-test models list                    # 列可用（已登录）
auto-test models list --all              # 列全部（含未登录）
auto-test models current                 # 查看当前
auto-test models select                  # 交互式选择
```

### 用例库

```bash
# 生成（v2.1 增加 --module / --group / --no-explore-cache）
auto-test generate "<desc>" --priority P0
auto-test generate "<desc>" --priority P1 --url https://example.com --page-object
auto-test generate "<desc>" --priority P0 --module 用户认证 --group auth
auto-test generate "<desc>" --priority P0 --no-explore-cache   # 强制刷新探索快照

# 列表（v2.1 增加 --module / --group）
auto-test list [--tag X] [--priority P0,P1] [--auth admin]
auto-test list --module 用户认证 --group auth --json

auto-test show auth/login-success
auto-test delete auth/login-success
```

### 登录态（auth 子系统）

```bash
auto-test auth init admin               # 生成手写模板
auto-test auth generate "<desc>" --name admin    # PI 生成
auto-test auth refresh admin            # 重跑 setup → 生成 storageState
auto-test auth list                     # 列所有 setup + 状态
```

### 运行

```bash
auto-test run                                    # 全部
auto-test run auth                               # 用例名前缀
auto-test run --priority P0                      # 冒烟
auto-test run --auth admin                       # auth=admin 的用例
auto-test run --header "X-Tenant=qa"             # 临时 header
auto-test run --storage-state <path>             # 临时 storageState
auto-test run --no-auth                          # 公开页
auto-test rerun                                  # 重跑最近失败
auto-test rerun --from <runId>                   # 指定 run
auto-test history --limit 10                     # 历史
auto-test heal auth/login-success                # 自愈
```

## 5. 鉴权注入（方式 C 详解）

### 优先级链

```
CLI flag (--header / --storage-state / --no-auth)
  ↓
process.env (AUTO_TEST_HEADER_<KEY> / AUTO_TEST_STORAGE_STATE / AUTO_TEST_NO_AUTH / BASE_URL / AUTH_TOKEN)
  ↓
.auto-test/config.json 的 auth 段
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
    npx auto-test auth refresh admin    # 重新生成 storageState
    npx auto-test run --priority P0
  env:
    AUTH_TOKEN: ${{ secrets.STAGING_TOKEN }}
    BASE_URL: ${{ vars.STAGING_URL }}
```

## 6. 登录态管理（auth 子系统）

### 目录约定

```
.auto-test/auth/
├── admin.setup.ts                # 登录流程（手写或 PI 生成）
├── anonymous.setup.ts            # 访客态
└── storage/
    ├── admin.json                # setup 产物（gitignore）
    └── anonymous.json
```

### 两种用法

**手写**（最快上手）：
```bash
auto-test auth init admin
# 编辑 .auto-test/auth/admin.setup.ts
auto-test auth refresh admin
```

**PI 生成**：
```bash
auto-test auth generate "管理员登录：admin/admin123，登录成功跳转 dashboard" --name admin
auto-test auth refresh admin
```

### Playwright 自动配置

`init` 渲染的 `.auto-test/playwright.config.ts` 自动拆 projects：

```typescript
projects: [
  { name: 'auth-setup', testMatch: /\.setup\.ts$/, testDir: './auth' },
  { name: 'e2e', testDir: './cases', dependencies: ['auth-setup'], use: { ... } }
]
```

`auth-setup` project 在没有 `*.setup.ts` 时是空的，被 Playwright 跳过。写了 setup 文件即自动生效。

### 用例关联 auth

`meta.json` 加 `auth: "<name>"`：

```json
{ "name": "dashboard/overview", "priority": "P0", "auth": "admin" }
```

跑用例：

```bash
auto-test run --auth admin
```

自动：
1. 过滤 `meta.auth === "admin"` 的用例
2. 注入 storageState = `.auto-test/auth/storage/admin.json`

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
auto-test generate "登录失败提示" \
  --priority P1 \
  --module 用户认证 \
  --group auth
```

`--module` 和 `--group` 会在 prompt 里以最高优先级告知 PI，绕过归一化层直接落盘，避免 PI 自由发挥产生脏目录。

## 8. 探索快照缓存（v2.1+）

### 用途

`generate --url` 在浏览器里打开 URL、抓 a11y 快照再让 LLM 看。当一个 URL 被反复生成（同一页面不同用例）时，每次都开浏览器很慢。

v2.1 把 `(URL + storageState)` 的快照落盘到 `.auto-test/cache/explore/`，TTL 内复用。

### 启用 / 禁用

- 默认 `explore.cache.enabled = true`
- 全局关闭：`explore.cache.enabled = false`
- 单次跳过：`auto-test generate ... --no-explore-cache`
- 手动清理：删除 `.auto-test/cache/` 或 `rm -rf .auto-test/cache/explore/*`

### 命中判定

缓存 key = `sha256(URL + storageState)`（按文件指纹 / mtime 计算），相同 (URL, 角色) 才命中：

```
URL: https://example.com/login  +  storageState: .auto-test/auth/storage/admin.json
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

样式更稳；用户可在 prompt 里强制走哪个场景，未来版本计划支持 `--example <name>` 显式指定。

## 10. 退出码

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

## 11. 常见问题

### Q：路径能改成 `e2e/` 吗？

**不能**。v2 强制 `.auto-test/`，避免配置漂移。

### Q：priority 必须是 P0-P3 吗？

是的。`generate --priority` 必填枚举。如果 PI 自由发挥会污染冒烟集。

### Q：项目根污染怎么办？

v2 后不存在。**老项目**手动删 `tests/`、`reports/`、`auto-test.config.json`（项目根），然后跑 `auto-test init` 重建。

### Q：需要多角色怎么办？

v2 默认单一角色。流程：
1. 先用一个角色跑完所有用例
2. `auto-test auth refresh <next-role>`
3. 跑另一角色用例

不同角色在不同测试批次切换，不并发。

### Q：CI 怎么注入 token？

`auth` 段写 `"Authorization": "Bearer ${AUTH_TOKEN}"`，CI 设 `AUTH_TOKEN` 环境变量即可。无需改代码。

### Q：LLM 不可用怎么办？

`auto-test models list` 看哪些 provider/model 已登录。未登录的 provider 需要在 pi-agent 里 `/login` 配置 API key。

### Q：PI 生成的 priority 不对？

强制约束在 `--priority` 锁定。如果发现 PI 输出 P1 但 CLI 传 P0，检查 `src/agent/tools.ts` 的 `save_case.execute`：应使用 `ctx.defaultPriority`。

### Q：PI 生成的 group 不对怎么办（v2.1+）？

generate 命令支持 `--group` / `--module` 强制锁定，传了之后跳过归一化层直接落盘：

```bash
auto-test generate "登录失败提示" --priority P1 --group auth --module 用户认证
```

### Q：探索快照多久失效？

`explore.cache.ttlMs` 默认 600000ms（10 分钟）。过期或 storageState 改变都会自动重建。

### Q：能关掉探索快照缓存吗？

- 配置：`explore.cache.enabled = false`
- 单次：`auto-test generate ... --no-explore-cache`
- 物理：`rm -rf .auto-test/cache/explore/`

## 12. 升级指南

### v1 → v2

1. 删项目根的 `auto-test.config.json` 和 `playwright.config.ts`
2. 删项目根的 `tests/` 和 `reports/`（如有）
3. 跑 `auto-test init` 重建 `.auto-test/` 布局
4. 跑 `auto-test models select` 选 LLM
5. 跑 `auto-test auth init <role>`（如需登录态）
6. 跑 `auto-test generate "<desc>" --priority P0` 开始

### v2 → v2.1

完全向后兼容：

- 首次运行会自动创建 `.auto-test/cache/`
- 旧项目无 `explore.cache` 配置时取默认值（启用、TTL 10 分钟）
- 想强制冷启动：`rm -rf .auto-test/cache/`
