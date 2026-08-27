# 端到端接入示例（v2）

从零接入 auto-test 的完整 6 步流程。

## 前置条件

- Node.js ≥ 18
- 项目根目录（任意项目：SPA、SSR、微前端均可）

## Step 1：初始化

```bash
cd my-project
npx auto-test init
```

**输出**：
```
✓ 目录就绪（新建 7 个）
✓ 写入 .auto-test/config.json
✓ 写入 .auto-test/playwright.config.ts
✓ 追加 .gitignore 条目

下一步：
  $ npm install
  $ npx playwright install chromium
  $ auto-test models select        # 选定 LLM provider/model
  $ auto-test generate "<测试需求描述>" --priority P0
```**项目根变化**：仅 `.gitignore` 多了 2 行（`.auto-test/reports/`、`.auto-test/.env`）。`auto-test.config.json`、`playwright.config.ts`、`tests/`、`reports/` 都不在项目根。

## Step 2：装依赖

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
```

## Step 3：选 LLM（首次必跑）

```bash
auto-test models select
```

**交互式选择**（用序号 + 回车）：
```
选择 provider
  1) anthropic
  2) openai
  3) google
  ...
  36) minimax-cn
> 36

选择 model (provider: minimax-cn)
  1) MiniMax-M2.7
  2) MiniMax-M2.7-highspeed
  3) MiniMax-M3
> 3

✓ 已写入 .auto-test/config.json：agent.model = "minimax-cn/MiniMax-M3"
```

**跳过交互**（CI 用）：
```bash
# 直接编辑 .auto-test/config.json 写 agent.model
```

## Step 4：生成用例

```bash
auto-test generate "登录：admin/admin123，登录成功跳转 dashboard" --priority P0
```

**生成产物**（`.auto-test/cases/login-success.meta.json`）：
```json
{
  "name": "login-success",
  "description": "登录：admin/admin123，登录成功跳转 dashboard",
  "priority": "P0",
  "group": "auth",
  "module": "用户认证",
  "linkedTickets": [],
  "tags": ["smoke", "happy-path"],
  ...
}
```

**`--priority` 必填**：P0 冒烟、P1 重要、P2 次要、P3 低优。

**`--url` 探索**（可选）：
```bash
auto-test generate "完整购买流程" --url https://staging.example.com--priority P1
```

## Step 5：跑测（公开页场景）

```bash
auto-test run --no-auth
```

`--no-auth` 跳过 storageState（适合不需登录的页面）。

## Step 6：登录用例（auth 子系统）

需要登录的页面走 auth 子系统：

### 6.1 初始化 setup 模板

```bash
auto-test auth init admin
```

**生成 `.auto-test/auth/admin.setup.ts`**：
```typescript
import { test as setup, expect } from '@playwright/test';

const STORAGE_STATE = '.auto-test/auth/storage/admin.json';

setup('admin login', async ({ page }) => {
  // TODO: 填登录步骤
  await page.context().storageState({ path: STORAGE_STATE });
});
```

### 6.2 手写登录步骤

编辑 `.auto-test/auth/admin.setup.ts`：```typescript
setup('admin login', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill(process.env.ADMIN_PASSWORD ?? 'admin123');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/dashboard/);
  await page.context().storageState({ path: STORAGE_STATE });
});
```

### 6.3 刷新 storageState

```bash
auto-test auth refresh admin
```

输出：`.auto-test/auth/storage/admin.json`（gitignore 自动忽略）。

### 6.4 用例关联 auth

`.auto-test/cases/dashboard/overview.meta.json`：
```json
{
  "name": "dashboard/overview",
  "priority": "P0",
  "auth": "admin",
  ...
}
```

### 6.5 跑 auth 关联用例

```bash
auto-test run --auth admin
```

自动：
- 过滤 `meta.auth === "admin"` 的用例
- 注入 storageState = `.auto-test/auth/storage/admin.json`
- 跳过 setup project（已 refresh 过）

## CI 集成

```yaml
# .github/workflows/e2e.yml
- name: E2E
  run: |
    npx auto-test auth refresh admin    # 重新生成 storageState
    npx auto-test run --priority P0      # 跑冒烟
  env:
    ADMIN_PASSWORD: ${{ secrets.ADMIN_PASSWORD }}
    BASE_URL: ${{ vars.STAGING_URL }}
```

## 常见问题

**Q：项目根污染怎么办？**
A：v2 后不存在——所有产物在 `.auto-test/`。老项目手动删 `tests/`、`reports/`、`auto-test.config.json`（项目根）。

**Q：priority 必须是 P0-P3 吗？**
A：是的。强约束避免 LLM 自由发挥污染冒烟集。如果想批量跑可省略 priority 但 generate 时必传。

**Q：路径能改成 `e2e/` 吗？**
A：不能。v2 强制 `.auto-test/`，避免配置漂移。

**Q：需要多角色怎么办？**
A：v2 阶段 2 默认单一角色。多角色场景先用一个角色跑完，再 refresh 切角色后跑。

**Q：CI 怎么注入 token？**
