#!/usr/bin/env node
/**
 * auto-test examples 的静态文件服务器
 *
 * 用法：
 *   node examples/serve.mjs             # 默认 http://localhost:4000
 *   PORT=3000 node examples/serve.mjs   # 自定义端口
 *
 * 设计原则：
 * - 零依赖：仅使用 Node.js 标准库
 * - 防路径穿越：normalize 后必须以 ROOT 开头
 * - 默认入口：GET / → /login-demo.html
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT ?? 4000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = (req.url ?? '/').split('?')[0] ?? '/';
    if (urlPath === '/') urlPath = '/login-demo.html';

    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const data = await readFile(filePath);
    const type = MIME[extname(filePath)] ?? 'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Not Found: ${req.url}`);
  }
});

server.listen(PORT, () => {
  console.log(`examples server listening on http://localhost:${PORT}`);
  console.log(`open: http://localhost:${PORT}/`);
});