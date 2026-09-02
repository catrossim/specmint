# specmint 示例

本目录展示真实项目接入 specmint 的典型场景。所有示例都基于 v0.2.0+ 布局（`.specmint/`），命令按 v0.7.0 校验。

## 场景 1：从零接入

参见 [`e2e-verify.md`](./e2e-verify.md)：在任意项目中跑 `specmint init` → 写用例 / `generate` → `adopt` → `review` → `run` 的完整流程。

## 场景 2：手动写用例（推荐路径）

参考 [`login-flow.spec.ts`](./login-flow.spec.ts) 的手写样例——演示 spec 文件结构、POM 用法、用例分组（`group/name.spec.ts`）。

写完的 spec.ts **必须 `adopt` 纳管**才会被 specmint 看见：

```bash
npx specmint adopt .specmint/cases/auth/login-success.spec.ts --priority P0
npx specmint verify                 # 静态可达性（v0.7.0+，退出码 15）
npx specmint review set auth/login-success --verdict approved
npx specmint run
```

没有 `meta.json` 的 spec.ts 会被 `list()` 静默跳过，`run` / `review` / verdict 卡口全部看不见它。

## 场景 3：generate 登录态注入（v0.5.0+）

参见 [`with-auth/`](./with-auth/)：演示 `specmint generate --url <需登录>` 时如何注入 storageState、多角色 `--auth <role>` 覆盖、启发式登录页 warning、缓存指纹隔离与 `generation.usedAuth` 审计字段。

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
| 纳管（**必需**） | `specmint adopt <file\|glob> --priority P0`（只写 meta.json，不动代码） |
| 静态校验 | `specmint lint [--strict]`（退出码 9） |
| 静态可达性（v0.7.0+） | `specmint verify`（退出码 15） |
| 裁决 | `specmint review`（TTY 进 REPL）/ `specmint review set <name> --verdict approved` |
| 列用例 | `specmint list --priority P0 --auth admin` |
| 详情 | `specmint show auth/login-success` |
| 登录态 | `specmint auth init admin` / `auth refresh admin` / `auth list` |
| 登录态运维（v0.7.0+） | `specmint auth doctor` / `auth debug <name>` / `auth lint` / `auth matrix --roles a,b` |
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

