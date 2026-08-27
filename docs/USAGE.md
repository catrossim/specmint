# auto-test 使用文档（v2）

面向测试工程师的完整使用指南。

## 1. 项目布局

v2 强制所有产物在 `.auto-test/` 下，项目根**零污染**。

```
my-project/
├── .gitignore                         # init 追加 .auto-test/reports/ 等规则
└── .auto-test/                         # auto-test 全部产物
    ├── config.json                    # 项目配置（位置不可改）
    ├── playwright.config.ts           # Playwright 配置（位置不可改）├── cases/                            # 用例库（递归支持 group/）
    │   └── auth/login-success.spec.ts
    │   └── auth/login-success.meta.json
    ├── cases/pages/                    # POM
    ├── auth/                           # 登录态子系统
    │   ├── admin.setup.ts              # 登录流程
    │   └── storage/admin.json          # storageState（gitignore）
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

### 完整配置（含 auth）

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
    "waitUntil": "domcontentloaded"
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
| `auth.cookies` | 否 |cookie 列表（schema 预留，阶段 2 完整支持）
| `auth.storageState` | 否 | Playwright `storageState` 路径 |

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
| `priority`| **是** | enum `P0\|P1\|P2\|P3` |
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

## 4. 命令清单

### 初始化```bash
auto-test init                 # 创建 .auto-test/ 布局
auto-test init --force         # 强制覆盖已存在的配置
```

### 模型选择

```bash
auto-test models list                    # 列可用（已登录）
auto-test models list --all             # 列全部（含未登录）
auto-test models current                # 查看当前
auto-test models select                 # 交互式选择
```

### 用例库

```bash
auto-test generate "<desc>" --priority P0           # 必传 priority
auto-test generate "<desc>" --priority P1 --url https://example.com --page-object
auto-test list [--tag X] [--priority P0,P1] [--auth admin]
auto-test show auth/login-success
auto-test delete auth/login-success
```

### 登录态（auth 子系统）

```bash
auto-test auth init admin               # 生成手写模板
auto-test auth generate "<desc>" --name admin    # PI 生成
auto-test auth refresh admin            # 重跑 setup →生成 storageState
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
process.env (AUTO_TEST_HEADER_<KEY> /AUTO_TEST_STORAGE_STATE / AUTO_TEST_NO_AUTH / BASE_URL / AUTH_TOKEN)
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
```## 6. 登录态管理（auth 子系统）

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

`init` 渲染的 `.auto-test/playwright.config.ts` 自动拆 projects：```typescript
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

`generate` 命令 prompt 里硬约束 LLM：- `priority` 必须用 enum（PI 不能改，由 CLI `--priority` 锁定）
- `group` 必须是 kebab-case
- `module` 用中文
- `linkedTickets` 是字符串数组
- `tags` 是小写 kebab-case

LLLM 输出仍可能不规范，**归一化层兜底**（`src/utils/normalize-meta.ts`）：
- `"高"` / `p0` / `"urgent"` / `"critical"` → `P0`
- `"中"` / `"medium"` → `P2`
- 其他不规范字段 → warning + 忽略（不阻塞保存）

**严格校验**（落盘前 `src/utils/case-schema.ts`）：
- `name` / `priority` 不合规 → throw（必填 + 强 enum）
- `group` / `module` / `linkedTickets` / `tags` → warning + 跳过

## 8. 退出码

| 码 | 含义 |
|----|------|
| 0 |成功 |
| 2 (USAGE_ERROR) | 参数错误 |
| 3 (NOT_IMPLEMENTED) | 子命令未实现 |
| 4 (NOT_FOUND) | 资源不存在 |
| 5 (ALREADY_EXISTS) | 重复创建 |
| 6 (AGENT_ERROR) | PI 调用失败 |
| 7 (TEST_FAILED) | 测试失败 |
| 8 (IO_ERROR) | IO 错误 |

## 9. 常见问题

### Q：路径能改成 `e2e/` 吗？

**不能**。v2 强制 `.auto-test/`，避免配置漂移。

### Q：priority 必须是 P0-P3 吗？

是的。`generate --priority` 必填枚举。如果 PI 自由发挥会污染冒烟集。

### Q：项目根污染怎么办？

v2 后不存在。**老项目**手动删 `tests/`、`reports/`、`auto-test.config.json`（项目根），然后跑 `auto-test init` 重建。### Q：需要多角色怎么办？

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

## 10. 升级指南（v1 → v2）

1. 删项目根的 `auto-test.config.json` 和 `playwright.config.ts`
2. 删项目根的 `tests/` 和 `reports/`（如有）
3. 跑 `auto-test init` 重建 `.auto-test/` 布局
4. 跑 `auto-test models select` 选 LLM
5. 跑 `auto-test auth init <role>`（如需登录态）
6. 跑 `auto-test generate "<desc>" --priority P0` 开始

