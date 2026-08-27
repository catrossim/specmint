# auto-test examples

一组用于端到端冒烟验证的示例资源，无任何 npm 依赖。

## 文件清单

- `login-demo.html` — 简易登录页面（含 `data-testid` 锚点，便于稳定选择）
- `dashboard.html` — 登录后跳转页
- `serve.mjs` — Node.js 静态文件服务器（仅用标准库）
- `login-flow.spec.ts` — 手写的高可读性 spec 范例（位于 examples/ 下，不会被 Playwright 自动加载）

## 启动 server

```bash
node examples/serve.mjs
# → http://localhost:4000

# 自定义端口
PORT=3000 node examples/serve.mjs
```

## 端到端冒烟流程

详见 `e2e-verify.md`，覆盖 init → generate → run → rerun → history → heal → skill export 全链路。

## 快速尝试手写用例

```bash
# 1. 启动 server
node examples/serve.mjs &

# 2. 设置 baseURL
export AUTO_TEST_BASE_URL=http://localhost:4000

# 3. 复制示例到用例库
cp examples/login-flow.spec.ts tests/login-flow.spec.ts

# 4. 运行
auto-test run login-flow
```

## 用 generate 生成新用例

```bash
# 探索模式（推荐，准确度更高）
auto-test generate \
  "登录：admin/admin123 登录成功跳转 dashboard，错误密码显示用户名或密码错误" \
  --url http://localhost:4000/login-demo.html \
  --name login-e2e

# 纯描述模式
auto-test generate "登录失败时显示用户名或密码错误" --name login-error-msg
```

## 清理

```bash
# 停止 server
kill %1

# 清理生成的产物
rm -rf tests/*.spec.ts tests/*.meta.json tests/*.bak
rm -rf reports/runs/*
```