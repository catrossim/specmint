---
name: specmint-auth
description: |
  管理 specmint 的登录态（auth 子系统）。当被测页面需要登录、需要配置或刷新
  storageState、需要多角色切换、或登录相关诊断报错时调用。
triggers:
  - 登录态
  - 页面需要登录
  - storageState
  - 多角色测试
  - 登录过期
  - cookie 注入
---

你负责**登录态管理** —— 让用例不必每次重复登录。

<!-- include: layout.md -->

---

## 核心思路

业务用例里**不写任何登录逻辑**。登录步骤单独做成 setup 文件，跑一次生成
`storageState`（cookies + localStorage），由 specmint 在执行时自动注入到所有用例。

```
.specmint/auth/<role>.setup.ts        # 登录步骤（一次编写）
.specmint/auth/storage/<role>.json    # 登录态产物（不入库，注意 .gitignore）
```

---

## 接入流程（首次 / 换密码 / 加新角色）

```bash
# 1. 生成 setup 模板（手写登录步骤最稳）
specmint auth init admin

# 2. 编辑 .specmint/auth/admin.setup.ts，填登录步骤

# 3. 跑一次 setup，生成 storageState
ADMIN_PASSWORD=xxx specmint auth refresh admin

# 4. 写进 .specmint/config.json（提交 git，团队共享）
#    { "auth": { "storageState": ".specmint/auth/storage/admin.json" } }
```

setup 文件的硬性要求（`auth lint` 会扫）：

- 密码从 `process.env` 读取，**禁止明文写死**
- 末尾必须调用 `await page.context().storageState({ path })`
- 登录成功后必须有 `await expect(page).toHaveURL(...)` 之类断言（失败要直接 fail，别静默写空 Cookie）

---

## 日常命令

```bash
specmint auth list                   # 所有 role：上次刷新时间 / Cookie 数 / setup 完整性
specmint auth doctor                 # 一行诊断（过期 / 缺断言 / 域名不匹配）
specmint auth lint                   # 静态扫描 setup 文件
specmint auth debug admin            # headed 模式逐步看登录过程
specmint auth matrix --roles admin,editor   # 多角色矩阵跑 + 对比表

# 让 LLM 起草登录步骤（登录页结构复杂时）
specmint auth generate --name admin --url https://example.com/login "用 admin 账号登录并跳转 /dashboard"
```

`auth doctor` 退出码非 0 时可直接作为 CI 前置检查。

---

## 注入优先级链

```
CLI flag (--header / --storage-state / --no-auth)
  ↓
process.env (SPECMINT_HEADER_<KEY> / SPECMINT_STORAGE_STATE / SPECMINT_NO_AUTH / AUTH_TOKEN)
  ↓
.specmint/config.json 的 auth 段 (headers / extraHTTPHeaders / cookies / storageState)
  ↓
Playwright 默认值
```

临时切换角色跑测：

```bash
specmint run --auth editor           # CLI 覆盖 config
SPECMINT_NO_AUTH=1 specmint run      # 完全不走 auth（公开页 demo）
```

生成用例时若目标页面需要登录，也要带上登录态，否则探索到的是登录页 DOM：

```bash
specmint generate "管理员查看订单" --url https://example.com/dashboard --auth admin --priority P1
```

---

## `run --auth <name>` 退出码与修复路径（v0.7.0 起）

`run --auth` 现在区分两种典型错误，agent 能直接定位修复动作：

| 退出码 | 名称 | 含义 | 修复路径 |
|---|---|---|---|
| `4` | NOT_FOUND | 名字拼错：`listAuth()` 中**没注册过**这个 role | 改 `--auth` 参数；或先 `specmint auth init <name>` 创建 setup 文件 |
| `11` | AUTH_EXPIRED | role 注册了但 `.specmint/auth/storage/<name>.json` **缺失或解析失败** | `specmint auth refresh <name>` 重生成 storageState；或加 `--no-auth` 跳过 |
| `0` | OK | role 注册 + storageState 完整 | — |

**判断规则**（v0.7.0 起硬性边界）：

1. `specmint auth list` 看到的 role 名 → **注册过**
2. 对应 `.specmint/auth/storage/<role>.json` 存在且 JSON 可解析 → **storageState 完整**
3. 两者都满足才进 `run`；否则按上表返回退出码与提示

**旧行为 vs 新行为**：

| 场景 | v0.6.0 | v0.7.0 |
|---|---|---|
| `--auth=typo`（没注册过） | 走到 Playwright 阶段报 `Cannot find module`（exit 7） | 早返 `NOT_FOUND (4)` + 提示 `用 \`specmint auth list\` 查看已注册的` |
| `--auth=admin`（role 注册但 storageState 缺失） | 走到 Playwright 阶段报 `Cannot find module`（exit 7） | 早返 `AUTH_EXPIRED (11)` + 提示 `运行 \`specmint auth refresh admin\`` |

CI 流水线推荐用 `11` 作为前置检查（角色 / storageState 都健康才允许后续 `run`）。

---

## 常见错误

| 现象 | 原因 / 处理 |
|---|---|
| Cookie 域名与 baseURL 不匹配 | `auth doctor` 会报；检查 `runner.baseURL` 与登录域名 |
| storageState 过期 | 默认 >24h 告警，重跑 `auth refresh <role>` |
| setup 跑成功但用例仍跳登录页 | config 里没配 `auth.storageState`，或 domain 不一致 |
| 明文密码被 lint 告警 | 改成 `process.env.XXX`，用 env 注入 |

<!-- include: contract.md -->
