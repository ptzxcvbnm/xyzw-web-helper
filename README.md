# XYZW 助手（前后端版）

一个把原纯前端 `xyzw_web_helper` 改造成 **前端 + 后端** 架构的游戏辅助管理器。后端常驻运行，关掉浏览器后定时任务仍继续执行，支持多用户隔离。

> 仅供学习交流使用。请勿用于任何商业或违反游戏服务条款的用途。

## 架构

```
浏览器(Vue3 前端) ──HTTP API + JWT──> Node.js 后端(Express) ──WebSocket──> 游戏服务器
     :3000                                  :3001
     只管 UI 展示                            所有游戏逻辑 + SQLite 存储(按 user_id 隔离)
                                            pm2 守护 / WebSocket 推送日志
```

- **前端**：Vue 3 + Vite + Naive UI + Pinia
- **后端**：Node.js + Express + 原生 WebSocket(ws) + better-sqlite3
- **认证**：JWT（密码 PBKDF2 哈希存储）
- **进程管理**：pm2

## 目录结构

| 路径 | 说明 |
|------|------|
| `src/` | 前端源码（Vue 组件、store、API 客户端） |
| `server/` | 后端源码（Express 入口、路由、游戏连接管理、SQLite） |
| `server/lib/gameManager.js` | 核心：管理所有账号的游戏 WebSocket 连接 |
| `server/lib/xyzwWebSocket.js` | Node 适配版游戏 WebSocket 客户端 |
| `server/lib/batch/` | 各类批量/定时任务逻辑 |
| `server/routes/` | REST API 路由 |

## 本地开发

```bash
# 安装依赖
pnpm install          # 前端
cd server && npm install   # 后端

# 启动后端（端口 3001）
cd server && node index.js

# 启动前端（端口默认 5173，已配置代理到后端 3001）
pnpm dev
```

## 生产部署

前端构建产物是纯静态文件，后端用 pm2 常驻。详见 [`HANDOVER.md`](./HANDOVER.md)。

```bash
# 构建前端（内存不足时加 swap，见 HANDOVER.md）
NODE_OPTIONS="--max-old-space-size=1536" npm run build

# 后端
cd server && pm2 start index.js --name xyzw-server

# 前端静态服务
pm2 start serve --name xyzw-web -- -s dist -l 3000
```

## 环境变量

后端支持以下可选环境变量：

| 变量 | 说明 | 默认 |
|------|------|------|
| `JWT_SECRET` | JWT 签名密钥，**生产环境务必设置** | 启动时随机生成 |
| `PORT` | 后端端口 | 3001 |

> 若不设置 `JWT_SECRET`，每次重启后端会重新生成密钥，导致已登录用户的 token 失效。生产环境请固定设置。

## 安全说明

- 数据库、登录凭证（`.bin`）、抓包文件等已在 `.gitignore` 中忽略，不会进入版本库。
- 首次运行会在 `server/data/` 下自动创建 SQLite 数据库。
- 请勿把 `server/data/`、`*.bin`、`server/config.json` 提交到公开仓库。

## License

CC-BY-NC-SA-4.0（署名 - 非商业性使用 - 相同方式共享）
