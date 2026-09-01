# specmint 端到端验证手册

> 适用版本：`specmint@0.3.0`（首个公开发版，含 review 执行关卡 + 自带 pi-coding-agent / playwright）。覆盖从零接入到 CI 跑测的完整 6 步流程。

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

## Step 2：选择 LLM

```bash
npx specmint models select
```

输出当前可用模型列表，选择后写入 `.specmint/config.json` 的 `agent.model` 字段。

> `specmint` 是 **agent SDK 调用 LLM**——你不必单独装 `@playwright/test`、`@playwright/browser`、`playwright-core`，全部由 specmint 自带（dependencies）。**项目根不需要 `npm install --save-dev playwright`**。

## Step 3：生成用例

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

## Step 6：登录用例（auth 子系统）

需要登录的页面走 auth 子系统：

### 5.1 初始化 setup 模板

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

### 5.2 手写登录步骤

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

### 5.3 刷新 storageState

```bash
npx specmint auth refresh admin
```

输出：`.specmint/auth/storage/admin.json`（已在 .gitignore 中，不会入仓库）。

### 5.4 用例关联 auth

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

### 5.5 跑 auth 关联用例

```bash
npx specmint run --auth admin
```

自动：

- 过滤 `meta.auth === "admin"` 的用例
- 注入 storageState = `.specmint/auth/storage/admin.json`
- 跳过 setup project（已 refresh 过）

> v0.2.0+ 仅在检测到 `*.setup.ts` 时挂载 auth-setup project，根治"占位 setup 失败连坐真实用例 → did not run"问题。

## CI 集成

```yaml
# .github/workflows/e2e.yml
- name: E2E
  run: |
    npx specmint auth refresh admin    # 重新生成 storageState
    npx specmint run --priority P0      # 跑冒烟
  env:
    ADMIN_PASSWORD: ${{ secrets.ADMIN_PASSWORD }}
    BASE_URL: ${{ vars.STAGING_URL }}
```

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