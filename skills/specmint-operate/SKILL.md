---
name: specmint-operate
description: |
  审核、执行、修复与归档 Playwright 测试用例。当用户需要人工裁决用例、
  跑测试、重跑失败用例、查看运行历史、自动修复失败用例、或配置 CI 门禁时调用。
  核心：只有 verdict=approved 的用例才会被执行。
triggers:
  - 审核用例
  - 裁决用例
  - 跑测试
  - 重跑失败用例
  - 修复失败用例
  - 查看测试历史
  - CI 门禁
---

你负责用例的**裁决、执行、修复与归档**。

<!-- include: layout.md -->

---

## verdict 状态机（执行卡口的依据）

```
pending ──[approved]──→ approved ──[run]──→ passed / failed
   │                       │                      │
   │                       └──[needs-fix]──→ needs-fix ──(heal)──→ 回到 pending
   ├──[rejected]──→ rejected（废弃）
   └──[skipped]──→ skipped
```

**卡口规则**（`config.json` 的 `review` 段，默认已全部开启）：

| 命令 | 默认行为 | 放宽标志 |
|---|---|---|
| `run` / `rerun` | 仅跑 `approved` | `--include-pending` / `--include-needs-fix` / `--include-rejected` / `--force` |
| `heal` | 仅修 `needs-fix` | `--include-pending` / `--include-approved` / `--include-rejected` / `--force` |

**两条容易踩的硬规则**：

1. 直传文件路径（`specmint run .specmint/cases/x.spec.ts`）时，若该文件**未纳管**
   （无 meta.json），执行会被**拒绝**——无法确认裁决状态就不放行。
2. 已 `approved` 的用例**内容被修改后自动回落 `pending`**，必须重新裁决。

---

## 人工裁决（review）

```bash
specmint review                    # TTY：进 REPL 翻页裁决（a/p/n/r/s 单键）
specmint review list               # 默认只看 pending
specmint review list --all --json
specmint review show <name>        # 单条详情
specmint review set <name> --verdict approved [--reviewer alice] [--note "..."]
```

REPL 键位：`a`=approved / `n`=needs-fix / `r`=rejected / `s`=skipped / `p`=pending / `q`=退出

审核前可用 `specmint show <name>` 查看用例代码与元数据，`specmint history --case <name>` 看历史表现。

作为 agent：生成/修复完用例后**主动提醒用户裁决**，不要代替用户标 approved
（人工审核的意义就在于此；除非用户明确要求批量放行）。

---

## 执行与历史

```bash
specmint run                       # 全量（仅 approved）
specmint run auth                  # 用例名/目录前缀
specmint run --priority P0         # 冒烟
specmint run --module 用户认证 --group auth
specmint run --label smoke         # 批次语义标签，便于识别
specmint rerun [--from <runId>]    # 重跑最近失败用例
specmint history [--limit N] [--case <name>]
```

批次产物落在 `.specmint/reports/runs/<batchId>/`：

| 文件 | 内容 |
|---|---|
| `run.json` | 结构化运行记录（命令、配置快照、结果汇总） |
| `results.json` | Playwright JSON reporter 输出 |
| `artifacts/` | 截图 / 视频 / trace |

---

## `run --auth` 错误码速查（v0.7.0 起）

`run --auth <name>` 现在在进入 Playwright 阶段**之前**先做完整性校验，把错误码语义从「隐式」变「可预测」：

| 退出码 | 名称 | 触发条件 | 修复动作 |
|---|---|---|---|
| `4` | NOT_FOUND | `--auth=<name>` 拼错：listAuth 里**没注册** | 改参数 / `specmint auth init <name>` |
| `11` | AUTH_EXPIRED | role 注册了，但 `.specmint/auth/storage/<name>.json` **不存在/失效** | `specmint auth refresh <name>` |
| `11` | AUTH_EXPIRED | 同上，预先校验阶段就 fail | 同上 |
| `7` | TEST_FAILED | storageState 完整、用例**真的跑失败**了 | 看 Playwright 报告 |

**两个 11 都是同一个根因**：storageState 缺失。区别只在触发早返的位置——前者是在 caseStore 过滤时发现，后者是在 storageState 默认路径预检时发现。

**早返位置**：

- 第一个 11：发生在 verdict gate 之前（`caseStore.list({auth})` 返回空后查 `listAuth()`）
- 第二个 11：发生在 verdict gate 之后、Playwright 调用之前（`options.storageState` 是默认派生路径时检查文件存在性）

两个 11 都给同样的 hint：`运行 \`specmint auth refresh <name>\` 生成；或加 --no-auth 跳过`。

CI 推荐：

```bash
specmint run --auth admin && specmint run    # 第一个 run 卡 auth 健康，第二个跑全部
```

---

## 自动修复（heal）

```bash
specmint heal <name>               # 默认仅 verdict=needs-fix
specmint heal <name> --from <runId>
```

heal 把「失败用例代码 + 错误日志」交给 LLM 修复，保持 group / module / linkedTickets 不变。
修完后用例仍是 `pending`，需重新裁决。

---

## CI 门禁

推荐用「零 pending 残留 + 指定优先级全通过」两段式，退出码非 0 即阻断：

```bash
# 1. 不允许有未裁决用例残留
PENDING=$(specmint review list --verdict pending --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).count||0))")
[ "$PENDING" -eq 0 ] || { echo "存在 $PENDING 条未裁决用例"; exit 1; }

# 2. 跑冒烟集（仅 approved）
specmint run --priority P0
```

- 卡口拦截退出码为 **4**（NOT_FOUND），不要当成「通过」
- 凭据用 env 注入：`AUTH_TOKEN=$SECRET specmint run --priority P0`
- `SPECMINT_JSON=1` 可让所有命令输出结构化 JSON

---

## 常见错误

| 现象 | 原因 / 处理 |
|---|---|
| `全部 N 条用例都被 verdict 过滤跳过` | 用例还是 pending，先 `specmint review` |
| `不在用例库中…已拒绝执行` | 该文件未纳管，先 `specmint adopt` |
| `No tests found` | 卡口生效但候选集为空；检查 `--priority` / `--module` 是否过窄 |
| 裁决后又被拦下 | 用例内容改过导致回落 pending，重新 `review set approved` |
| `heal` 无反应 | 默认只修 needs-fix，先 `review set <name> --verdict needs-fix` |

<!-- include: contract.md -->
