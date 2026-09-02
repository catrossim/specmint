## 输出约定

- 所有命令支持 `--json`：stdout 只输出 JSON，日志走 stderr，便于 agent 直接解析
- 错误结构化：`{ ok: false, error: { code, message, hint } }`
- 非 JSON 模式下，结构化错误信息同样会打印 `message` 与 `提示: hint`

### 退出码（agent/CI 据此分支处理）

| 码 | 常量 | 含义 | agent 该如何反应 |
|---|---|---|---|
| 0 | OK | 成功 | 继续下一步 |
| 2 | USAGE_ERROR | 参数错误 / 元数据缺失 | 修正参数重试（如补 `--priority`） |
| 4 | NOT_FOUND | 资源不存在，**或被 verdict 卡口过滤** | 检查用例名；若提示 pending，先走人工裁决 |
| 5 | ALREADY_EXISTS | 重复创建 | 加 `--force` 覆盖，或改用更新路径 |
| 7 | TEST_FAILED | 用例执行失败 | 查 `history`，必要时 `heal` |
| 9 | LINT_FAILED | 静态校验未通过 | 修 spec 后重新 `adopt`（不要 `--no-lint` 绕过） |

### CI 集成要点

- 凭据一律用 env 注入：`AUTH_TOKEN=$SECRET specmint run --priority P0`
- `config.json` 的 `auth` 段支持 `${ENV_VAR}` 占位符
- 卡口失败（退出码 4）应视为「流程未完成」，不是「测试通过」
