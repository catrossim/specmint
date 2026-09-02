# examples/with-auth · v2.6 generate 登录态注入演示

本目录用最小可复现的方式演示 specmint v0.5.0（内部 v2.6）新增的 generate 登录态注入能力。

## 它解决了什么问题

v0.5.0 之前，`specmint generate --url <需登录的URL>` 在探索阶段根本不会向 Playwright 注入任何登录态。后果：

- URL 拿到的就是未登录 DOM（多半是登录页本身）
- LLM 拿这个 DOM 推断出来的用例也全部基于登录页写出来
- 跑测时直接失败：`page.goto('/dashboard')` → server 302 → /login

v0.5.0 把"配置侧已具备但没接上"的能力补完：CLI `--auth <role>` 显式覆盖 + `config.auth.storageState` 默认走通 + 缓存按登录态隔离 + 落盘审计。

## 文件结构

```
examples/with-auth/
├── README.md                           # 本文件：3 个场景走读
├── dashboard.html                      # 受 auth-session cookie 保护的页面
├── storage/
│   ├── admin.json                      # 预录的 admin 角色 storageState
│   └── viewer.json                     # 预录的 viewer 角色 storageState（多角色演示）
└── .specmint-config.example.json       # 复制到 .specmint/config.json 即可生效
```

## 准备

```bash
# 1. 起静态文件服务器（已有 examples/serve.mjs）
node examples/serve.mjs &
# → http://localhost:4000

# 2. （可选）浏览器先看一眼
# - http://localhost:4000/login-demo.html   登录表单
# - http://localhost:4000/with-auth/dashboard.html
#     没 cookie → 跳走（演示受保护行为）
#     浏览器 devtools 手动加 cookie `auth-session=demo-admin-session-token-7f3c1d` 后 → 看到 Dashboard
```

## 场景 1：项目级单一身份（最常见）

```bash
# 把示例 config 拷到 .specmint/config.json
cp examples/with-auth/.specmint-config.example.json .specmint/config.json

# 跑 generate（不传 --auth，让 config.auth.storageState 起作用）
specmint generate \
  --url http://localhost:4000/with-auth/dashboard.html \
  --description "管理员查看订单 Dashboard" \
  --priority P1

# 预期日志：
#   [auth] 使用登录态: role=config storageState=examples/with-auth/storage/admin.json
#   探索完成: title="Dashboard (Protected) · ..."  ← 注意！拿到了 Dashboard 而非登录页
#   ✓ save_case cases/order-dashboard.spec.ts
```

**关键对比**：把 `examples/with-auth/.specmint-config.example.json` 删了/挪走再跑同一命令，title 会变成 `Login Demo`，日志里会多一行 `[auth] 未配置登录态：...` 的 warning。

## 场景 2：多角色 + `--auth <role>` 覆盖

```bash
# 临时切到 viewer 角色（不修改 config）
specmint generate \
  --url http://localhost:4000/with-auth/dashboard.html \
  --auth viewer \
  --description "查看者查看订单 Dashboard" \
  --priority P2

# 预期日志：
#   [auth] 使用登录态: role=cli storageState=.specmint/auth/storage/viewer.json
#   ← 注意 storageState 路径被 --auth 覆盖
```

CLI `--auth <role>` 始终覆盖 `config.auth.storageState`，与 CI 调用习惯一致。

## 场景 3：不传 auth → 启发式 warning

```bash
# 临时禁用 auth（rename config 让 specmint 找不到）
mv .specmint/config.json .specmint/config.json.bak

specmint generate \
  --url http://localhost:4000/with-auth/dashboard.html \
  --description "管理员查看订单 Dashboard" \
  --priority P1

# 预期日志：
#   [auth] 未配置登录态：未设置 config.auth 且未传 --auth <role>。...
#   探索完成: title="Login Demo · specmint examples"   ← 拿到的是登录页
#   [auth] 探索结果看起来是登录页（title/url 含 login/signin/oauth/sso 或 password input），
#           且本次未注入登录态。生成的用例将基于未登录态页面。
#   ✓ save_case cases/order-dashboard.spec.ts  ← 还是落盘了，但不 fail
```

启发式探测命中后只 warning，不 fail-fast，让 generate 流程不被打断。

## 缓存隔离（核心防错点）

每次 generate 都把 `storageStateFingerprint`（路径 + key 名 hash）拼到 explore cache key：

```bash
# 同一个 URL，admin 跑一次 → admin-fingerprint 缓存
specmint generate --url .../with-auth/dashboard.html --auth admin --priority P1
# 探索日志：[auth] 使用登录态: role=cli storageState=.../admin.json

# 再用 viewer 跑 → viewer-fingerprint 缓存（不会复用 admin 的快照）
specmint generate --url .../with-auth/dashboard.html --auth viewer --priority P2
# 探索日志：[auth] 使用登录态: role=cli storageState=.../viewer.json
#     即使 fingerprint 不同，强制重抓
```

可以用 `ls .specmint/cache/explore/` 看到不同 fingerprint 后缀的 cache 文件。

## 审计字段 `generation.usedAuth`

每个生成的用例 meta 里会落一份脱敏审计：

```bash
cat .specmint/cases/order-dashboard.spec.json | jq .generation
```

```json
{
  "mode": "agent",
  "model": "anthropic/...",
  "exploredUrl": "http://localhost:4000/with-auth/dashboard.html",
  "selectorPolicy": "testid",
  "usedAuth": {
    "role": "cli",                          // ← cli / config / config-inline / none
    "storageStatePath": ".specmint/auth/storage/admin.json",
    "headerKeys": []                        // ← 仅 key 名，token 不落盘
  }
}
```

**不存 token / cookie value**——三个月后回看用例时知道当时用了哪个登录态，但 git 历史里没有 secret 泄露。

## 与正式登录态流程的边界

本示例用预录的 storageState 是为了"零依赖可复现"。**生产项目请走正式流程**：

```bash
# 1. 生成 setup 模板并手写登录步骤
specmint auth init admin
# → .specmint/auth/admin.setup.ts

# 2. 跑一次 setup，生成 storageState
ADMIN_PASSWORD=xxx specmint auth refresh admin
# → .specmint/auth/storage/admin.json

# 3. 列出已注册的 role（含上次刷新时间 / Cookie 数 / setup 完整性）
specmint auth list
```

预录文件过期 / 凭据变更 / 服务器对 cookie 加密时，预录版本会失效——这正是走正式流程的价值。

**v0.7.0 起**可用运维命令定位登录态问题：

```bash
specmint auth doctor          # 一行诊断：过期 / 缺断言 / Cookie 域名与 baseURL 不匹配
specmint auth lint            # 静态扫 setup：明文密码 / 缺 storageState() / 缺成功断言
specmint auth debug admin     # headed + 慢动作逐步看登录过程
specmint auth matrix --roles admin,viewer   # 多角色矩阵跑 + pass/fail 对比表
```

## 边界与不在范围

本示例不演示：

- **OAuth / SSO 流程编排** —— v0.5.0 不做，仍需手写 `auth init` 生成的 setup 步骤
- **Token 自动刷新** —— v2.7+ 议题
- **Playwright projects 多角色拆分**（`.specmint/auth/*.setup.ts`）—— v0.5.0 不动这部分
- **真实服务端 cookie 校验** —— 本示例用 client-side `<script>` 模拟，生产环境请让 server 端 401/302

详见 [CHANGELOG v0.5.0](../../CHANGELOG.md#050---2026-09-01)。