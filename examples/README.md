# specmint 示例

本目录展示真实项目接入 specmint 的两种典型场景。所有示例都基于 v0.2.0+ 布局（`.specmint/`）。

## 场景 1：从零接入

参见 [`e2e-verify.md`](./e2e-verify.md)：在任意项目中跑 `specmint init` → `models select` → `generate` → `run` 的完整 6 步流程。

## 场景 2：手动写用例

参考 [`login-flow.spec.ts`](./login-flow.spec.ts) 的手写样例——演示 spec 文件结构、POM 用法、用例分组（`group/name.spec.ts`）。

## 目录约定

```
my-project/
└── .specmint/                     # 所有 specmint 产物
    ├── config.json                 # 项目配置（不可改路径）
    ├── cases/                      # 用例库（递归支持 group/）
    │   └── auth/login-success.spec.ts
    ├── cases/pages/                # POM
    ├── auth/                       # 登录态
    │   ├── admin.setup.ts
    │   └── storage/admin.json
    ├── cache/                      # 探索快照缓存
    │   └── explore/
    └── reports/                    # 运行产物（gitignore）
        └── runs/<batchId>/
            ├── run.json
            └── artifacts/
```

**项目根零污染**：specmint 不会在项目根创建 `tests/`、`reports/`、`specmint.config.json`、`playwright.config.ts`。

## 命令速查

| 类别 | 命令 |
|------|------|
| 初始化 | `specmint init` |
| 模型 | `specmint models select` |
| 单条生成 | `specmint generate "<desc>" --priority P0` |
| 批量生成（逗号） | `specmint generate "用例1, 用例2" --priority P0` |
| 批量生成（推荐） | `specmint generate --batch-file ./specs.txt --priority P0 --concurrency 3` |
| 批量生成（管道） | `printf "用例1\n用例2" \| specmint generate --priority P0` |
| 裁决 | `specmint review`（TTY 进 REPL）/ `specmint review set <name> --verdict approved` |
| 列用例 | `specmint list --priority P0 --auth admin` |
| 详情 | `specmint show auth/login-success` |
| 登录态 | `specmint auth init admin` / `auth refresh admin` / `auth list` |
| 跑测 | `specmint run --auth admin --priority P0` |
| 重跑失败 | `specmint rerun` |
| 自愈 | `specmint heal <name>`（仅 verdict=needs-fix） |

## 配置示例

`.specmint/config.json`：

```json
{
  "agent": { "delegate": "sdk" },
  "runner": { "defaultBrowser": "chromium" },
  "auth": {
    "headers": { "X-Tenant": "qa" },
    "extraHTTPHeaders": { "Authorization": "Bearer ${AUTH_TOKEN}" },
    "storageState": ".specmint/auth/storage/default.json"
  }
}
```

