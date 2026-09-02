# specmint 端到端验证手册

> 适用版本：`specmint@0.7.0`（流程自 `0.3.0` 首个公开发版起沿用至今）。覆盖从零接入到 CI 跑测的完整 6 步流程。
>
> v0.6.0 起推荐**路径 A：手写 / agent 写 spec.ts → `adopt` 纳管**，无需 LLM；`generate`（LLM 起草）降级为可选路径 B。

## Step 1：初始化

```bash
npx specmint init
```

**输出**（v0.2.0+ 不再生成任何项目根文件）：

```
✓ 已创建 .specmint/
✓ 已创建 .specmint/cases/
✓ 已创建 .specmint/cases/pages/
✓ 已创建 .specmint/reports/runs/
✓ 已创建 .specmint/auth/
✓ 已创建 .specmint/auth/storage/
✓ 已创建 .specmint/cache/explore/
✓ 已写入 .specmint/config.json
✓ 已追加 .gitignore 条目（5 行）
```

> **v0.2.0 变化**：init 不再生成 `.specmint/playwright.config.ts` 与 `.specmint/specmint-reporter.ts`——这两个文件完全在包内（`dist/runner/`），executor 通过 `import.meta.url` 定位。深度自定义可用 `specmint run --config <path>` 显式覆盖。

## Step 2：选择 LLM（仅路径 B 需要）

走路径 A（手写用例 + `adopt`）**可以整步跳过**，不需要任何 LLM。

```bash
npx specmint models select
```

输出当前可用模型列表，选择后写入 `.specmint/config.json` 的 `agent.model` 字段。

> `specmint` 是 **agent SDK 调用 LLM**——你不必单独装 `@playwright/test`、`@playwright/browser`、`playwright-core`，全部由 specmint 自带（dependencies）。**项目根不需要 `npm install --save-dev playwright`**。

## Step 3：产出用例

### 路径 A（推荐）：手写 spec.ts → `adopt` 纳管

**没有 `meta.json` 的 spec.ts 对 specmint 不可见**——`list()` 会静默跳过它，`run` / `review` / 卡口全都看不见。所以写完必须 `adopt`。

```bash
# 1. 写标准 Playwright TS：.specmint/cases/auth/login-success.spec.ts
#    推荐在头部写 @specmint 注释预填元数据：
#    /**
#     * @specmint module: 用户认证
#     * @specmint priority: P0
#     * @specmint tag: smoke
#     */

# 2. 纳管（只写 meta.json，绝不改动你的代码；默认跑 lint，error 红线拒绝入仓）
npx specmint adopt .specmint/cases/auth/login-success.spec.ts --priority P0

# 3. 批量 / 整库
npx specmint adopt "auth/**/*.spec.ts" --priority P1
npx specmint adopt --priority P2 --module 订单管理

# 4. 静态可达性校验（v0.7.0+，不启动浏览器，退出码 15）
npx specmint verify
```

元数据优先级：**CLI 参数 > 文件头部 `@specmint` 注释 > 文件路径推导**。 `--priority` 缺失 → 拒绝纳管；`--group` 与文件所在目录不一致 → 拒绝纳管。

已 `approved` 的用例内容一改（`contentHash` 变化）会自动回落 `pending`，必须重新裁决；CI 重纳管场景用 `--keep-verdict` 保留。

### 路径 B：用 LLM 生成

```bash
npx specmint generate "登录成功" --priority P0
```

**`--priority` 必填**：P0 冒烟 / P1 重要 / P2 次要 / P3 低优。归一化层兜底，输入"高"/p0/urgent 都视为 P0。

**`--url` 探索**（可选）：

```bash
specmint generate "完整购买流程" --url https://staging.example.com --priority P1
```

v0.2.0+ 还会把 `(URL, 登录态) → a11y 快照` 落盘到 `.specmint/cache/explore/`，TTL 默认 10 分钟；同 URL 反复生成时直接复用，强制刷新用 `--no-explore-cache`。v0.5.0 起登录态以**指纹**（storageState 路径或 headers/cookies 的 key 名 hash，不 hash value）参与缓存 key——同 URL 换角色自动失效重抓，admin 抓的快照不会被 viewer 误用。

**`--auth <role>` 登录态注入**（v0.5.0+，需登录的页面必看）：

```bash
# 需登录页面：不注入登录态时探索拿到的是登录页 DOM，生成的用例必错
specmint generate "管理员查看订单 Dashboard" \
  --url https://staging.example.com/dashboard \
  --auth admin \
  --priority P1
```

优先级：CLI `--auth <role>` > `config.auth.storageState` > headers/cookies > 未登录态（warning 但不 fail）。端到端演示见 [`examples/with-auth/`](./with-auth/)。

### 批量生成（推荐用法）

`generate` 单次调用 = **1 条用例** = **1 个 `.spec.ts` 文件**。批量场景用以下三种方式：

```bash
# 方式 A：逗号糖（兼容旧版，但描述里如果有逗号会被误切，慎用）
npx specmint generate "管理员登录,管理员看到待办,管理员审批通过" --priority P0

# 方式 B：--batch-file（推荐，每行一条，# 开头为注释，跳过空行）
cat > ./specs.txt <<'EOF'
# 冒烟集
管理员登录后台
管理员看到待办列表
管理员审批通过一条待办
EOF
npx specmint generate --batch-file ./specs.txt --priority P0 --concurrency 3

# 方式 C：stdin 管道（适合 CI / Makefile）
printf "用例1\n用例2\n用例3" | npx specmint generate --priority P0 --concurrency 3
```

> **不要**在描述里写"限制 6 条用例"——specmint 单次只生成 1 条用例；想要 N 条用例 = N 次独立调用 / N 行 batch-file / N 行 stdin。
>
> 并发与 checkpoint：`--concurrency N` 控制并发（默认 2），`--checkpoint <dir>` 每完成一条增量写 state（崩溃/Ctrl-C 可 `--resume`），失败自动隔离不影响其他用例。

## Step 4：review 裁决（v0.3+，可选但推荐）

> **v0.3.0 新增**：run / heal 现在受 verdict 卡口过滤。首次接入 review 流程可跳过本步，直接在 `.specmint/config.json` 设 `"review": { "requireBeforeRun": false, "requireBeforeHeal": false }` 回到 v0.2.0 老行为。
>
> **v0.6.0 强化**：未裁决（`pending`）的用例**永远不会被执行**——这是硬卡口而非提示；且未纳管（无 `meta.json`）的文件会被 `run` 直接拒绝（退出码 4）。退出码 4 应视为「流程未完成」，不要当成「测试通过」。

```bash
# 1. 进入 REPL 翻页裁决（首次进 TTY）
npx specmint review
```

按 `[a/p/n/r/s/q]` 单键翻页裁决全部用例。verdict 默认 `pending`，所有 v0.3.0 的 `run` 默认跳过 pending 用例。

```bash
# 2. 脚本/CI 场景：单条裁决
npx specmint review set login-success --verdict approved --reviewer alice
npx specmint review set login-failure --verdict needs-fix --reason "selector 飘"

# 3. 查看全部 needs-fix 用例
npx specmint review list --verdict needs-fix

# 4. 查看单条详情
npx specmint review show login-success
```

跑 REPL 时敲 `q` 退出。下一步 `specmint run` 默认仅跑 approved 用例。

## Step 5：跑测（公开页场景）

```bash
npx specmint run --no-auth
```

`--no-auth` 跳过 storageState（适合不需登录的页面）。

**跑之前的三层检查**（v0.7.0 起，按代价从低到高）：

```bash
npx specmint lint      # 风格红线：缺断言 / waitForTimeout / 易碎定位器 → 退出码 9
npx specmint verify    # 可达性：空 test 体 / getByTestId 未在契约声明 → 退出码 15
npx specmint run       # 动态执行：真正起浏览器 → 退出码 7
```

CI 里推荐串成 `specmint lint && specmint verify && specmint run`，逐层 fail-fast。

## Step 6：登录用例（auth 子系统）

需要登录的页面走 auth 子系统：

### 6.1 初始化 setup 模板

```bash
npx specmint auth init admin
```

**生成 `.specmint/auth/admin.setup.ts`**（带详细 TODO 注释与 storageState 路径提示）：

```typescript
import { test as setup, expect } from '@playwright/test';

/**
 * admin 登录流程（手写模板）
 *
 * 流程结束后必须调用 `page.context().storageState({ path })` 保存登录态。
 * storageState 路径固定为：.specmint/auth/storage/admin.json
 *
 * 推荐：登录成功后用 `await expect(page).toHaveURL(/dashboard/)` 等做断言，
 * 避免登录失败但 storageState 仍然生成（导致 e2e 用例莫名其妙失败）。
 */
const STORAGE_STATE = '.specmint/auth/storage/admin.json';

setup('admin login', async ({ page }) => {
  await page.goto('/login');

  // TODO: 填入登录步骤
  // await page.getByLabel('用户名').fill('admin');
  // await page.getByLabel('密码').fill(process.env.ADMIN_PASSWORD ?? '');
  // await page.getByRole('button', { name: '登录' }).click();
  // await expect(page).toHaveURL(/dashboard/);

  await page.context().storageState({ path: STORAGE_STATE });
});
```

### 6.2 手写登录步骤

编辑 `.specmint/auth/admin.setup.ts`：

```typescript
setup('admin login', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill(process.env.ADMIN_PASSWORD ?? 'admin123');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.context().storageState({ path: STORAGE_STATE });
});
```

或者用 LLM 生成（按页面行为自动写）：

```bash
npx specmint auth generate "管理员登录后台" --name admin --url https://staging.example.com
```

### 6.3 刷新 storageState

```bash
npx specmint auth refresh admin
```

输出：`.specmint/auth/storage/admin.json`（已在 .gitignore 中，不会入仓库）。

### 6.4 用例关联 auth

`.specmint/cases/dashboard/overview.meta.json`：

```json
{
  "name": "dashboard/overview",
  "priority": "P0",
  "auth": "admin",
  "module": "Dashboard",
  "group": "overview",
  "description": "管理员登录后进入概览页"
}
```

### 6.5 跑 auth 关联用例

```bash
npx specmint run --auth admin
```

**无显式目标时**（没有 pattern / `--grep`）自动：

- 过滤 `meta.auth === "admin"` 的用例
- 注入 storageState = `.specmint/auth/storage/admin.json`
- 跳过 setup project（已 refresh 过）

**已指定显式目标时**（如 `specmint run auth/login-success --auth admin`），`--auth` **只注入登录态，不按 `meta.auth` 过滤**，并会打印一条语义警告提醒你。

错误码（v0.7.0 起在进入 Playwright 之前就早返，不再拖到 `Cannot find module`）：

| 退出码 | 含义 | 修复 |
|---|---|---|
| `4` | 角色名拼错（`auth list` 里没注册） | 改参数，或先 `specmint auth init <name>` |
| `11` | 角色已注册但 `.specmint/auth/storage/<name>.json` 缺失 / 失效 | `specmint auth refresh <name>`，或加 `--no-auth` |

> v0.2.0+ 仅在检测到 `*.setup.ts` 时挂载 auth-setup project，根治"占位 setup 失败连坐真实用例 → did not run"问题。

### 6.6 登录态运维（v0.7.0 新增）

```bash
npx specmint auth doctor                      # 一行诊断：过期(>24h) / 缺断言 / Cookie 域名不匹配
npx specmint auth doctor --expiry-hours 48    # 自定义过期阈值
npx specmint auth lint                        # 静态扫 setup：明文密码 / 缺 storageState() / 缺成功断言（退 13）
npx specmint auth debug admin                 # headed + 慢动作逐步看登录过程卡在哪
npx specmint auth matrix --roles admin,viewer # 多角色矩阵跑同一批用例 + pass/fail 对比表（失败退 7）
```

`auth doctor` 有告警退 `1`，可直接作 CI 前置 gate。

## CI 集成

```yaml
# .github/workflows/e2e.yml
- name: E2E
  run: |
    npx specmint auth refresh admin    # 重新生成 storageState（退出码 12 = 登录步骤失败）
    npx specmint auth doctor           # 登录态健康前置检查（有问题退 1）
    npx specmint lint                  # 风格红线（退出码 9）
    npx specmint verify                # 静态可达性（退出码 15）
    npx specmint run --priority P0     # 跑冒烟（仅 verdict=approved；未裁决残留退 4）
  env:
    ADMIN_PASSWORD: ${{ secrets.ADMIN_PASSWORD }}
    BASE_URL: ${{ vars.STAGING_URL }}
```

退出码速查：`4` 未裁决 / 未纳管（**不是通过**）、`7` 用例跑挂、`9` lint 失败、`11` 登录态缺失、`12` 登录失败、`15` verify 失败。

## 常见问题

**Q：项目根被污染了怎么办？**

A：v0.2.0 起所有产物都在 `.specmint/`，**项目根零污染**。如果你的项目根仍有遗留：

- 老的 `specmint.config.json` → 删除
- 老的 `playwright.config.ts` → 删除（v0.2.0+ 包内自带）
- 老的 `tests/` / `reports/` / `test-results/` → 删除

删除后跑一次 `npx specmint init`（幂等；已有 `.specmint/` 不会重建），再用 `specmint run` 验证。

**Q：`specmint` 与 `@playwright/test` 是什么关系？**

A：`specmint` 是上层 wrapper，**已把 `@playwright/test` 装在自身 dependencies**，业务项目不需要再装。CLI 通过 `playwright.config.ts`（包内 `dist/runner/`）spawn `npx playwright test` 子进程跑用例，产物（screenshots / videos / traces）落盘到 `.specmint/reports/runs/<batchId>/artifacts/`。

**Q：CI 怎么注入 token？**

A：两种方式：

1. **环境变量**（推荐）：`setup` 文件读 `process.env.ADMIN_PASSWORD`，CI 流水线把 secrets 注入到 env：
   ```yaml
   env:
     ADMIN_PASSWORD: ${{ secrets.ADMIN_PASSWORD }}
     BASE_URL: ${{ vars.STAGING_URL }}
   ```
2. **storageState 作为 CI 制品**：本地 `auth refresh` 后把 `.specmint/auth/storage/admin.json` 上传到 artifacts，CI 下载后再跑测（避免每次 CI 都重登）。但 storageState 会失效，复杂登录务必用方式 1。