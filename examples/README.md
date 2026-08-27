# auto-test 示例

本目录展示真实项目接入 auto-test 的两种典型场景。所有示例都基于 v2 布局（`.auto-test/`）。

## 场景 1：从零接入

参见 [`e2e-verify.md`](./e2e-verify.md)：在任意项目中跑 `auto-test init` → `models select` → `generate` → `run` 的完整 6 步流程。

## 场景 2：手动写用例

参考 `tests/login-admin.*`（已迁移到 `.auto-test/cases/login-admin.*`）的手写样例。

## 目录约定（v2）

```
my-project/
└── .auto-test/                     # 所有 auto-test 产物
    ├── config.json                # 项目配置（不可改路径）├── playwright.config.ts       # Playwright 配置
    ├── cases/                      # 用例库（递归支持 group/）
    │   └── auth/login-success.spec.ts
    ├── cases/pages/                # POM
    ├── auth/                       # 登录态（阶段 2）
    │   ├── admin.setup.ts
    │   └── storage/admin.json
    └── reports/                    # 运行产物（gitignore）
        └── runs/<ts>/run.json
```

**项目根零污染**：auto-test 不会在项目根创建 `tests/`、`reports/`、`auto-test.config.json`、`playwright.config.ts`。

## 命令速查

| 类别 | 命令 |
|------|------|
| 初始化 | `auto-test init` |
| 模型 | `auto-test models select` |
| 生成用例 | `auto-test generate "<desc>" --priority P0` |
| 列用例 | `auto-test list --priority P0 --auth admin` |
| 详情 | `auto-test show auth/login-success` || 登录 | `auto-test auth init admin` / `auth refresh admin` / `auth list` |
| 跑测 | `auto-test run --auth admin --priority P0` |
| 重跑失败 | `auto-test rerun` |
| 自愈 | `auto-test heal <name>` |

## 配置示例

`.auto-test/config.json`：

```json
{
  "agent": { "delegate": "sdk" },
  "runner": { "defaultBrowser": "chromium" },
  "auth": {
    "headers": { "X-Tenant": "qa" },
    "extraHTTPHeaders": { "Authorization": "Bearer ${AUTH_TOKEN}" },
    "storageState": ".auto-test/auth/storage/default.json"
  }
}
```

